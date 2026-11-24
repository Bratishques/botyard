import { Injectable } from '@nestjs/common'
import { type Selectable, sql } from 'kysely'
import type { BotDeploymentTable, OperationTable } from '../../../shared/database/schema'
import { UnitOfWork } from '../../../shared/database/unit-of-work'
import type {
  Deployment,
  DeploymentBasis,
  DeploymentDrift,
  DeploymentRepository,
  DeploymentStatus,
  Operation,
  OperationKind,
} from '../domain/deployment'
import { firstStep } from '../domain/saga'

const DEPLOYMENT_COLUMNS = [
  'id',
  'customer_id',
  'destination_id',
  'template_id',
  'template_version',
  'config',
  'trading_mode',
  'app_name',
  'status',
  'dokploy_app_id',
  'active_operation_id',
  'last_error',
  'drift',
  'drift_checked_at',
  'version',
  'created_at',
  'updated_at',
] as const

const OPERATION_COLUMNS = [
  'id',
  'deployment_id',
  'kind',
  'status',
  'step',
  'attempt',
  'error',
  'requested_by',
  'created_at',
  'finished_at',
] as const

@Injectable()
export class PostgresDeploymentRepository implements DeploymentRepository {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  /**
   * Запросы — по одному: в транзакции одно соединение, `Promise.all` здесь ничего не ускоряет, а порядок
   * блокировок делает случайным. Шаблон блокируется отдельно от чтения манифеста: строка, дождавшаяся
   * синхронизации каталога, перечитывается Postgres только сама, а соединение с версией осталось бы от
   * старого снимка — и живой шаблон выглядел бы недоступным. Следующий запрос берёт свежий снимок.
   */
  async lockBasis(customerId: string, destinationId: string, templateId: string): Promise<DeploymentBasis> {
    const db = this.unitOfWork.db()
    const customer = await db
      .selectFrom('customer')
      .select(['id', 'status', 'sandbox'])
      .where('id', '=', customerId)
      .forShare()
      .executeTakeFirst()
    const destination = await db
      .selectFrom('destination')
      .select(['id', 'status'])
      .where('id', '=', destinationId)
      .forShare()
      .executeTakeFirst()
    const template = await db
      .selectFrom('bot_template')
      .select(['id', 'current_version', 'retired'])
      .where('id', '=', templateId)
      .forShare()
      .executeTakeFirst()
    const version = template
      ? await db
          .selectFrom('bot_template_version')
          .select('manifest')
          .where('template_id', '=', template.id)
          .where('version', '=', template.current_version)
          .executeTakeFirstOrThrow()
      : undefined

    return {
      customer: customer ?? null,
      destination: destination ?? null,
      template:
        template && version
          ? {
              id: template.id,
              currentVersion: template.current_version,
              retired: template.retired,
              configSchema: version.manifest.config.schema,
              verifiesTls: version.manifest.security?.verifiesTls === true,
            }
          : null,
    }
  }

  async dueForDriftCheck(intervalMs: number, limit: number): Promise<Deployment[]> {
    const rows = await this.unitOfWork
      .db()
      .selectFrom('bot_deployment')
      .innerJoin('destination', 'destination.id', 'bot_deployment.destination_id')
      .select(DEPLOYMENT_COLUMNS.map((column) => `bot_deployment.${column}` as const))
      .where('bot_deployment.active_operation_id', 'is', null)
      .where('bot_deployment.status', 'in', ['RUNNING', 'STOPPED', 'FAILED'])
      .where('bot_deployment.dokploy_app_id', 'is not', null)
      .where('destination.status', '<>', 'DISABLED')
      .where((where) =>
        where.or([
          where('bot_deployment.drift_checked_at', 'is', null),
          where('bot_deployment.drift_checked_at', '<', sql<Date>`now() - make_interval(secs => ${intervalMs / 1000})`),
        ]),
      )
      .orderBy(sql`bot_deployment.drift_checked_at NULLS FIRST`)
      .limit(limit)
      .execute()

    return rows.map(toDeployment)
  }

  async recordDrift(
    id: string,
    version: number,
    checkedAt: Date | null,
    drift: DeploymentDrift | null | undefined,
  ): Promise<{ previous: DeploymentDrift | null } | false> {
    const result = await sql<{ previous: DeploymentDrift | null }>`
      UPDATE bot_deployment d
      SET drift_checked_at = now()${drift === undefined ? sql`` : sql`, drift = ${drift}`}
      FROM (SELECT id, drift FROM bot_deployment WHERE id = ${id} FOR UPDATE) old
      WHERE d.id = old.id AND d.version = ${version} AND d.active_operation_id IS NULL
        -- В Postgres микросекунды, в прочитанном Date — миллисекунды: сравнение с усечением
        AND date_trunc('milliseconds', d.drift_checked_at) IS NOT DISTINCT FROM ${checkedAt}::timestamptz
      RETURNING old.drift AS previous
    `.execute(this.unitOfWork.db())
    const [row] = result.rows

    return row ? { previous: row.previous } : false
  }

  async lockDestinationStatus(destinationId: string): Promise<string | null> {
    const row = await this.unitOfWork
      .db()
      .selectFrom('destination')
      .select('status')
      .where('id', '=', destinationId)
      .forShare()
      .executeTakeFirst()

    return row?.status ?? null
  }

  async insert(
    deployment: Omit<Deployment, 'version' | 'createdAt' | 'updatedAt' | 'dokployAppId' | 'lastError' | 'drift' | 'driftCheckedAt'>,
  ): Promise<Deployment> {
    const row = await this.unitOfWork
      .db()
      .insertInto('bot_deployment')
      .values({
        id: deployment.id,
        customer_id: deployment.customerId,
        destination_id: deployment.destinationId,
        template_id: deployment.templateId,
        template_version: deployment.templateVersion,
        config: JSON.stringify(deployment.config),
        trading_mode: deployment.tradingMode,
        app_name: deployment.appName,
        status: deployment.status,
        active_operation_id: deployment.activeOperationId,
      })
      .returning(DEPLOYMENT_COLUMNS)
      .executeTakeFirstOrThrow()

    return toDeployment(row)
  }

  async insertOperation(operation: { id: string; deploymentId: string; kind: OperationKind; requestedBy: string }): Promise<Operation> {
    const row = await this.unitOfWork
      .db()
      .insertInto('operation')
      .values({
        id: operation.id,
        deployment_id: operation.deploymentId,
        kind: operation.kind,
        step: firstStep(operation.kind),
        requested_by: operation.requestedBy,
      })
      .returning(OPERATION_COLUMNS)
      .executeTakeFirstOrThrow()

    return toOperation(row)
  }

  async findById(id: string): Promise<Deployment | null> {
    const row = await this.unitOfWork.db().selectFrom('bot_deployment').select(DEPLOYMENT_COLUMNS).where('id', '=', id).executeTakeFirst()

    return row ? toDeployment(row) : null
  }

  async list(): Promise<Deployment[]> {
    const rows = await this.unitOfWork.db().selectFrom('bot_deployment').select(DEPLOYMENT_COLUMNS).orderBy('created_at', 'desc').execute()

    return rows.map(toDeployment)
  }

  async operations(deploymentId: string): Promise<Operation[]> {
    const rows = await this.unitOfWork
      .db()
      .selectFrom('operation')
      .select(OPERATION_COLUMNS)
      .where('deployment_id', '=', deploymentId)
      .orderBy('created_at', 'desc')
      .execute()

    return rows.map(toOperation)
  }

  async claim(
    id: string,
    expectedVersion: number,
    operationId: string,
    from: readonly DeploymentStatus[],
    claimAs: DeploymentStatus | null,
  ): Promise<Deployment | null> {
    const row = await this.unitOfWork
      .db()
      .updateTable('bot_deployment')
      .set({
        active_operation_id: operationId,
        ...(claimAs !== null && { status: claimAs }),
        version: sql<number>`version + 1`,
        updated_at: new Date(),
      })
      .where('id', '=', id)
      .where('version', '=', expectedVersion)
      .where('active_operation_id', 'is', null)
      .where('status', 'in', [...from])
      .returning(DEPLOYMENT_COLUMNS)
      .executeTakeFirst()

    return row ? toDeployment(row) : null
  }
}

function toDeployment(row: Selectable<BotDeploymentTable>): Deployment {
  return {
    id: row.id,
    customerId: row.customer_id,
    destinationId: row.destination_id,
    templateId: row.template_id,
    templateVersion: row.template_version,
    config: row.config,
    tradingMode: row.trading_mode,
    appName: row.app_name,
    status: row.status,
    dokployAppId: row.dokploy_app_id,
    activeOperationId: row.active_operation_id,
    lastError: row.last_error,
    drift: row.drift,
    driftCheckedAt: row.drift_checked_at,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toOperation(row: Pick<Selectable<OperationTable>, (typeof OPERATION_COLUMNS)[number]>): Operation {
  return {
    id: row.id,
    deploymentId: row.deployment_id,
    kind: row.kind,
    status: row.status,
    step: row.step,
    attempt: row.attempt,
    error: row.error,
    requestedBy: row.requested_by,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  }
}
