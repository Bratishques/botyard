import { Injectable } from '@nestjs/common'
import { sql } from 'kysely'
import { UnitOfWork } from '../../../shared/database/unit-of-work'
import { OutboxTopic } from '../../../shared/outbox/outbox'
import type { ClaimedStep, ClaimRefusal, Finish, OperationStore, StalledOperation } from '../domain/operation-store'
import { isSagaStep, type SagaStep } from '../domain/saga'

/** Не чаще — пробуждение ожидания деплоя вебхуком */
export const NUDGE_INTERVAL_MS = 5_000

/**
 * Операции для воркера саги в Postgres. Аренда — условная запись по шагу и времени аренды; все дальнейшие
 * записи воркера — по шагу и идентификатору аренды, полученным при захвате. Время — базы (`now()`), не процесса.
 */
@Injectable()
export class PostgresOperationStore implements OperationStore {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  async claim(operationId: string, step: SagaStep, wake: string | null, leaseMs: number): Promise<ClaimedStep | ClaimRefusal> {
    // Захват и проверка причины отказа — два запроса: между ними аренда могла истечь. Тогда «свободно, но
    // не захвачено» — повторить захват, а не отбросить единственную команду операции
    for (let round = 0; round < 3; round++) {
      const claimed = await this.tryClaim(operationId, step, wake, leaseMs)
      if (claimed) return claimed

      const current = await this.unitOfWork
        .db()
        .selectFrom('operation')
        .select([
          'status',
          'step',
          'lease_until',
          sql<boolean>`coalesce(lease_until > now(), false)`.as('leased'),
          sql<string>`coalesce(context->>'wakeNonce', '')`.as('wake'),
        ])
        .where('id', '=', operationId)
        .executeTakeFirst()
      const active = current && ['PENDING', 'RUNNING'].includes(current.status) && current.step === step && current.wake === (wake ?? '')
      if (!active) return { reason: 'stale' }
      if (current.leased && current.lease_until) return { reason: 'leased', until: current.lease_until }
    }

    // Не захватили трижды подряд при свободном шаге — отложить, а не потерять
    return { reason: 'leased', until: new Date() }
  }

  protected async tryClaim(operationId: string, step: SagaStep, wake: string | null, leaseMs: number): Promise<ClaimedStep | null> {
    const row = await this.unitOfWork
      .db()
      .updateTable('operation')
      .set({
        status: 'RUNNING',
        attempt: sql<number>`attempt + 1`,
        lease_until: sql<Date>`now() + make_interval(secs => ${leaseMs / 1000})`,
        lease_id: sql<string>`gen_random_uuid()`,
        updated_at: sql<Date>`now()`,
      })
      .where('id', '=', operationId)
      .where('step', '=', step)
      .where('status', 'in', ['PENDING', 'RUNNING'])
      .where((where) => where.or([where('lease_until', 'is', null), where('lease_until', '<', sql<Date>`now()`)]))
      .where(sql<string>`coalesce(context->>'wakeNonce', '')`, '=', wake ?? '')
      .returning(['id', 'deployment_id', 'kind', 'step', 'attempt', 'lease_id', 'context'])
      .executeTakeFirst()
    if (!row?.step || !isSagaStep(row.step) || !row.lease_id) return null

    return {
      operationId: row.id,
      deploymentId: row.deployment_id,
      kind: row.kind,
      step: row.step,
      attempt: row.attempt,
      leaseId: row.lease_id,
      context: row.context,
    }
  }

  async advance(claimed: ClaimedStep, next: SagaStep, context: Record<string, unknown>, dokployAppId?: string): Promise<boolean> {
    return this.unitOfWork.run(async () => {
      // Шаг продвинулся: метка пробуждения и счётчик пинков reconciler'а относятся к прошлому шагу
      const { wakeNonce: _wake, kicks: _kicks, ...rest } = context
      const moved = await this.held(claimed)
        .set({ step: next, attempt: 0, lease_until: null, context: JSON.stringify(rest), updated_at: sql<Date>`now()` })
        .executeTakeFirst()
      if (Number(moved.numUpdatedRows) === 0) return false
      if (dokployAppId !== undefined) await this.setAppId(claimed, dokployAppId)

      return true
    })
  }

  async release(
    claimed: ClaimedStep,
    context: Record<string, unknown>,
    wake: string,
    options: { resetAttempts: boolean },
  ): Promise<boolean> {
    const released = await this.held(claimed)
      .set({
        lease_until: null,
        // Счётчик пинков — из строки, а не из снимка воркера: опоздавший воркер не должен его стереть
        context: sql<string>`${JSON.stringify({ ...context, wakeNonce: wake })}::jsonb
          || CASE WHEN operation.context ? 'kicks' THEN jsonb_build_object('kicks', operation.context->'kicks') ELSE '{}'::jsonb END`,
        updated_at: sql<Date>`now()`,
        ...(options.resetAttempts && { attempt: 0 }),
      })
      .executeTakeFirst()

    return Number(released.numUpdatedRows) > 0
  }

  async finish(claimed: ClaimedStep, finish: Finish): Promise<boolean> {
    return this.unitOfWork.run(async () => {
      const finished = await this.held(claimed)
        .set({
          status: finish.operation,
          error: finish.error,
          lease_until: null,
          finished_at: sql<Date>`now()`,
          updated_at: sql<Date>`now()`,
        })
        .executeTakeFirst()
      if (Number(finished.numUpdatedRows) === 0) return false

      await this.unitOfWork
        .db()
        .updateTable('bot_deployment')
        .set({
          status: finish.deploymentStatus,
          last_error: finish.error,
          active_operation_id: null,
          // Операция сама привела Dokploy к своему итогу: прежнее наблюдение дрейфа устарело
          drift: null,
          drift_checked_at: null,
          version: sql<number>`version + 1`,
          updated_at: sql<Date>`now()`,
          ...(finish.dokployAppId !== undefined && { dokploy_app_id: finish.dokployAppId }),
        })
        .where('id', '=', claimed.deploymentId)
        .where('active_operation_id', '=', claimed.operationId)
        .execute()

      return true
    })
  }

  async stalled(idleMs: number, limit: number): Promise<StalledOperation[]> {
    const rows = await this.unitOfWork
      .db()
      .selectFrom('operation')
      .select(['id', 'deployment_id', 'kind', 'step', sql<number>`coalesce((context->>'kicks')::int, 0)`.as('kicks')])
      .where('status', 'in', ['PENDING', 'RUNNING'])
      .where((where) => where.or([where('lease_until', 'is', null), where('lease_until', '<', sql<Date>`now()`)]))
      .where('updated_at', '<', sql<Date>`now() - make_interval(secs => ${idleMs / 1000})`)
      // Команда ещё лежит в outbox (relay стоит или публикация отложена) — не потеряна, а в заторе:
      // будить нечего, лишний пинок только добавил бы ещё одну команду в тот же затор
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom('outbox_message')
              .select(sql`1`.as('one'))
              .where('published_at', 'is', null)
              .where('topic', '=', OutboxTopic.OPERATION_STEP)
              .whereRef(sql`outbox_message.payload->>'operationId'`, '=', sql`operation.id::text`),
          ),
        ),
      )
      .orderBy('updated_at')
      .limit(limit)
      .execute()

    return rows.flatMap((row) =>
      row.step && isSagaStep(row.step)
        ? [{ operationId: row.id, deploymentId: row.deployment_id, kind: row.kind, step: row.step, kicks: row.kicks }]
        : [],
    )
  }

  async kick(stalled: StalledOperation, wake: string, idleMs: number): Promise<boolean> {
    const kicked = await this.stillStalled(stalled, idleMs)
      .set({
        context: sql<string>`context || jsonb_build_object('wakeNonce', ${wake}::text, 'kicks', ${stalled.kicks + 1}::int)`,
        lease_until: null,
        updated_at: sql<Date>`now()`,
      })
      .executeTakeFirst()

    return Number(kicked.numUpdatedRows) > 0
  }

  async abandon(stalled: StalledOperation, finish: Finish, idleMs: number): Promise<boolean> {
    return this.unitOfWork.run(async () => {
      const abandoned = await this.stillStalled(stalled, idleMs)
        .set({
          status: finish.operation,
          error: finish.error,
          lease_until: null,
          finished_at: sql<Date>`now()`,
          updated_at: sql<Date>`now()`,
        })
        .executeTakeFirst()
      if (Number(abandoned.numUpdatedRows) === 0) return false

      await this.unitOfWork
        .db()
        .updateTable('bot_deployment')
        .set({
          status: finish.deploymentStatus,
          last_error: finish.error,
          active_operation_id: null,
          // Операция сама привела Dokploy к своему итогу: прежнее наблюдение дрейфа устарело
          drift: null,
          drift_checked_at: null,
          version: sql<number>`version + 1`,
          updated_at: sql<Date>`now()`,
        })
        .where('id', '=', stalled.deploymentId)
        .where('active_operation_id', '=', stalled.operationId)
        .execute()

      return true
    })
  }

  async nudgeAwaitingDeploy(destinationId: string, appName: string, wake: string): Promise<StalledOperation | null> {
    const result = await sql<{ id: string; deployment_id: string; kind: StalledOperation['kind']; kicks: number }>`
      UPDATE operation o
      SET context = o.context || jsonb_build_object('wakeNonce', ${wake}::text, 'nudgedAt', now()),
          lease_until = NULL,
          updated_at = now()
      FROM bot_deployment d
      WHERE d.active_operation_id = o.id
        AND d.destination_id = ${destinationId}
        AND d.app_name = ${appName}
        AND o.step = 'await_deploy'
        AND o.status IN ('PENDING', 'RUNNING')
        AND (o.lease_until IS NULL OR o.lease_until < now())
        -- Не чаще раза в NUDGE_INTERVAL на операцию: поток вебхуков (повторы Dokploy, подделки с утёкшим
        -- секретом) не превращается в поток опросов Dokploy
        AND coalesce((o.context->>'nudgedAt')::timestamptz, '-infinity'::timestamptz)
          < now() - make_interval(secs => ${NUDGE_INTERVAL_MS / 1000})
      RETURNING o.id, o.deployment_id, o.kind, coalesce((o.context->>'kicks')::int, 0) AS kicks
    `.execute(this.unitOfWork.db())
    const [row] = result.rows
    if (!row) return null

    return { operationId: row.id, deploymentId: row.deployment_id, kind: row.kind, step: 'await_deploy', kicks: row.kicks }
  }

  /** Условие reconciler'а: тот же шаг, не завершена, аренды нет, без движения, пинков столько же, сколько прочитано */
  private stillStalled(stalled: StalledOperation, idleMs: number) {
    return this.unitOfWork
      .db()
      .updateTable('operation')
      .where('id', '=', stalled.operationId)
      .where('step', '=', stalled.step)
      .where('status', 'in', ['PENDING', 'RUNNING'])
      .where((where) => where.or([where('lease_until', 'is', null), where('lease_until', '<', sql<Date>`now()`)]))
      .where('updated_at', '<', sql<Date>`now() - make_interval(secs => ${idleMs / 1000})`)
      .where(sql<number>`coalesce((context->>'kicks')::int, 0)`, '=', stalled.kicks)
  }

  /** Запись по аренде: та же аренда, тот же шаг, операция идёт */
  private held(claimed: ClaimedStep) {
    return this.unitOfWork
      .db()
      .updateTable('operation')
      .where('id', '=', claimed.operationId)
      .where('step', '=', claimed.step)
      .where('lease_id', '=', claimed.leaseId)
      .where('status', '=', 'RUNNING')
  }

  private async setAppId(claimed: ClaimedStep, dokployAppId: string): Promise<void> {
    await this.unitOfWork
      .db()
      .updateTable('bot_deployment')
      .set({ dokploy_app_id: dokployAppId, updated_at: sql<Date>`now()` })
      .where('id', '=', claimed.deploymentId)
      .where('active_operation_id', '=', claimed.operationId)
      .execute()
  }
}
