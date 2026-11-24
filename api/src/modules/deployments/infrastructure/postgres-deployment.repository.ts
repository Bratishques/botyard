import { Injectable } from '@nestjs/common'
import { type Selectable, sql } from 'kysely'
import type { BotDeploymentTable, DeploymentStatus, OperationKind, OperationTable } from '../../../shared/database/schema'
import { UnitOfWork } from '../../../shared/database/unit-of-work'
import type { Deployment, DeploymentBasis, DeploymentRepository, Operation } from '../domain/deployment'

const DEPLOYMENT_COLUMNS = [
  'id',
  'customer_id',
  'destination_id',
  'template_id',
  'template_version',
  'config',
  'app_name',
  'status',
  'dokploy_app_id',
  'active_operation_id',
  'last_error',
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

  async lockBasis(customerId: string, destinationId: string, templateId: string): Promise<DeploymentBasis> {
    const db = this.unitOfWork.db()
    const [customer, destination, template] = await Promise.all([
      db.selectFrom('customer').select(['id', 'status']).where('id', '=', customerId).forShare().executeTakeFirst(),
      db.selectFrom('destination').select(['id', 'status']).where('id', '=', destinationId).forShare().executeTakeFirst(),
      db
        .selectFrom('bot_template')
        .innerJoin('bot_template_version', (join) =>
          join
            .onRef('bot_template_version.template_id', '=', 'bot_template.id')
            .onRef('bot_template_version.version', '=', 'bot_template.current_version'),
        )
        .select(['bot_template.id', 'bot_template.current_version', 'bot_template.retired', 'bot_template_version.manifest'])
        .where('bot_template.id', '=', templateId)
        .forShare('bot_template')
        .executeTakeFirst(),
    ])

    return {
      customer: customer ?? null,
      destination: destination ?? null,
      template: template
        ? {
            id: template.id,
            currentVersion: template.current_version,
            retired: template.retired,
            configSchema: template.manifest.config.schema,
          }
        : null,
    }
  }

  async insert(deployment: Omit<Deployment, 'version' | 'createdAt' | 'updatedAt' | 'dokployAppId' | 'lastError'>): Promise<Deployment> {
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
      .values({ id: operation.id, deployment_id: operation.deploymentId, kind: operation.kind, requested_by: operation.requestedBy })
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
    appName: row.app_name,
    status: row.status,
    dokployAppId: row.dokploy_app_id,
    activeOperationId: row.active_operation_id,
    lastError: row.last_error,
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
