import { Inject, Injectable, Logger } from '@nestjs/common'
import { Counter } from 'prom-client'
import { AuditLog } from '../../../shared/audit/audit'
import { UnitOfWork } from '../../../shared/database/unit-of-work'
import { registry } from '../../../shared/observability/metrics'
import { Outbox, OutboxTopic } from '../../../shared/outbox/outbox'
import { DEPLOYMENT_EVENTS, type DeploymentEvents } from '../../../shared/realtime/deployment-events'
import { OPERATION_STORE, type OperationStore, type StalledOperation } from '../domain/operation-store'
import { OUTCOME, OUTCOME_IN_DOKPLOY } from '../domain/saga'

const kicked = new Counter({
  name: 'botyard_reconciler_operations_kicked_total',
  help: 'Застрявшие операции, которым reconciler заново отправил команду шага',
  registers: [registry],
})
const abandoned = new Counter({
  name: 'botyard_reconciler_operations_abandoned_total',
  help: 'Застрявшие операции, закрытые reconciler как FAILED после всех пинков',
  registers: [registry],
})

export const RECONCILE = {
  /**
   * Без движения дольше этого — застряла. Самая длинная законная пауза — повтор шага через 5 мин
   * (RETRY.maxDelayMs) или аренда 5 мин, и обе обновляют `updated_at`; порог вдвое больше
   */
  idleMs: 10 * 60_000,
  /** Сколько раз будить на одном шаге без прогресса, прежде чем сдаться */
  maxKicks: 3,
  /** То же для шагов, чей исход решается в Dokploy: ~70 мин — дольше дедлайна деплоя в воркере (30 мин) */
  maxKicksInDokploy: 6,
  batch: 50,
} as const

const ACTOR = 'system:reconciler'

/**
 * Reconciler операций: находит операции, у которых пропала команда (сообщение потеряно, outbox очистили,
 * воркер упал так, что повтор не запланирован), и будит их; после `maxKicks` пинков без прогресса — закрывает
 * как FAILED и снимает захват с развёртывания, чтобы оператор не застрял с 409 навсегда.
 *
 * - Операция, чья команда ещё лежит в outbox неопубликованной, не застряла — она в заторе (relay стоит).
 * - На шагах, исход которых решается в Dokploy (deploy, await_deploy, start), reconciler ждёт дольше и
 *   закрывает с текстом «состояние в Dokploy неизвестно»: ранний FAILED соврал бы, робот запустится.
 *
 * - Пинок — условная запись с новой меткой пробуждения и командой в outbox в одной транзакции: старая команда,
 *   если всё-таки доедет, устареет, и двух цепочек не будет.
 * - Конкурентно с воркером безопасно: захват шага обновляет `updated_at` и ставит аренду — пинок тогда не
 *   пройдёт; пинок первым — команда воркера со старой меткой устареет, а пинок принесёт новую.
 * - Несколько reconciler'ов не мешают друг другу: условие включает прочитанный счётчик пинков.
 */
@Injectable()
export class OperationReconciler {
  private readonly logger = new Logger(OperationReconciler.name)

  constructor(
    @Inject(OPERATION_STORE) private readonly store: OperationStore,
    private readonly unitOfWork: UnitOfWork,
    private readonly outbox: Outbox,
    private readonly audit: AuditLog,
    @Inject(DEPLOYMENT_EVENTS) private readonly events: DeploymentEvents,
  ) {}

  /** Один проход; сколько операций разбужено и сколько закрыто */
  async tick(): Promise<{ kicked: number; abandoned: number }> {
    const result = { kicked: 0, abandoned: 0 }
    for (const stalled of await this.store.stalled(RECONCILE.idleMs, RECONCILE.batch)) {
      const limit = OUTCOME_IN_DOKPLOY.has(stalled.step) ? RECONCILE.maxKicksInDokploy : RECONCILE.maxKicks
      if (stalled.kicks >= limit) {
        if (await this.giveUp(stalled)) {
          result.abandoned++
          this.events.changed(stalled.deploymentId)
        }
      } else if (await this.wake(stalled)) {
        result.kicked++
      }
    }

    return result
  }

  private wake(stalled: StalledOperation): Promise<boolean> {
    const wake = Bun.randomUUIDv7()

    return this.unitOfWork.run(async () => {
      if (!(await this.store.kick(stalled, wake, RECONCILE.idleMs))) return false
      await this.outbox.enqueue(OutboxTopic.OPERATION_STEP, {
        operationId: stalled.operationId,
        deploymentId: stalled.deploymentId,
        kind: stalled.kind,
        step: stalled.step,
        wake,
      })
      kicked.inc()
      this.logger.warn({ operationId: stalled.operationId, step: stalled.step, kick: stalled.kicks + 1 }, 'stalled operation woken up')

      return true
    })
  }

  private giveUp(stalled: StalledOperation): Promise<boolean> {
    const unknown = OUTCOME_IN_DOKPLOY.has(stalled.step)
      ? '; its state in Dokploy is unknown — check the application in Dokploy before retrying'
      : '; the robot was not touched by this decision'
    const error =
      `the operation made no progress on step ${stalled.step} after ${stalled.kicks} restarts ` +
      `(check that the saga worker and the outbox relay are running)${unknown}`

    return this.unitOfWork.run(async () => {
      const done = await this.store.abandon(
        stalled,
        { operation: 'FAILED', error, deploymentStatus: OUTCOME[stalled.kind].failed },
        RECONCILE.idleMs,
      )
      if (!done) return false
      await this.audit.record({
        actor: ACTOR,
        action: `deployment.${stalled.kind.toLowerCase()}_failed`,
        targetType: 'deployment',
        targetId: stalled.deploymentId,
        payload: { operationId: stalled.operationId, step: stalled.step, error },
      })
      abandoned.inc()
      this.logger.error({ operationId: stalled.operationId, step: stalled.step }, 'stalled operation abandoned')

      return true
    })
  }
}
