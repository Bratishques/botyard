import type { ColumnType, Generated } from 'kysely'
import type { TemplateManifest } from '../catalog/template-manifest'

/**
 * Типы таблиц для Kysely. Источник истины — миграции в `migrations/`; этот файл правится
 * в том же коммите, что и миграция.
 */
export interface Database {
  destination: DestinationTable
  audit_event: AuditEventTable
  operator: OperatorTable
  operator_session: OperatorSessionTable
  customer: CustomerTable
  bot_template: BotTemplateTable
  bot_template_version: BotTemplateVersionTable
  bot_deployment: BotDeploymentTable
  operation: OperationTable
  outbox_message: OutboxMessageTable
  idempotency_record: IdempotencyRecordTable
  destination_webhook: DestinationWebhookTable
  webhook_inbox: WebhookInboxTable
}

type CreatedAt = ColumnType<Date, Date | undefined, never>
type UpdatedAt = ColumnType<Date, Date | undefined, Date>

export interface DestinationTable {
  id: string
  name: string
  base_url: string
  api_key_sealed: Uint8Array
  api_key_hint: string
  project_id: string
  environment_id: string
  server_id: string | null
  status: Generated<'ACTIVE' | 'UNREACHABLE' | 'DISABLED'>
  last_checked_at: Date | null
  last_error: string | null
  version: Generated<number>
  created_at: CreatedAt
  updated_at: UpdatedAt
}

export interface AuditEventTable {
  id: string
  actor: string
  action: string
  target_type: string
  target_id: string | null
  payload: ColumnType<Record<string, unknown>, Record<string, unknown> | undefined, never>
  // Время события ставит база: журнал, где время задаёт вызывающий, ничего не доказывает
  created_at: ColumnType<Date, never, never>
}

export interface OperatorTable {
  id: string
  email: string
  password_hash: string
  created_at: CreatedAt
}

export interface OperatorSessionTable {
  token_hash: Uint8Array
  operator_id: string
  created_at: CreatedAt
  expires_at: Date
  revoked_at: Date | null
}

export interface CustomerTable {
  id: string
  name: string
  account_id: string
  tinvest_token_sealed: Uint8Array
  tinvest_token_hint: string
  sandbox: Generated<boolean>
  status: Generated<'ACTIVE' | 'ARCHIVED'>
  version: Generated<number>
  created_at: CreatedAt
  updated_at: UpdatedAt
}

export interface BotTemplateTable {
  id: string
  current_version: string
  retired: Generated<boolean>
  updated_at: UpdatedAt
}

export interface BotTemplateVersionTable {
  template_id: string
  version: string
  name: string
  manifest: ColumnType<TemplateManifest, string, never>
  files: ColumnType<Record<string, string>, string | undefined, never>
  loaded_at: CreatedAt
}

export type DeploymentStatus = 'PROVISIONING' | 'RUNNING' | 'STOPPED' | 'FAILED' | 'DELETING' | 'DELETED'
export type OperationKind = 'PROVISION' | 'START' | 'STOP' | 'REDEPLOY' | 'DELETE'
export type OperationStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED'

export interface BotDeploymentTable {
  id: string
  customer_id: string
  destination_id: string
  template_id: string
  template_version: string
  config: ColumnType<Record<string, unknown>, string, never>
  trading_mode: 'sandbox' | 'live'
  app_name: string
  status: DeploymentStatus
  dokploy_app_id: string | null
  active_operation_id: string | null
  last_error: string | null
  version: Generated<number>
  created_at: CreatedAt
  updated_at: UpdatedAt
}

export interface OperationTable {
  id: string
  deployment_id: string
  kind: OperationKind
  status: Generated<OperationStatus>
  step: string | null
  attempt: Generated<number>
  error: string | null
  requested_by: string
  lease_until: Date | null
  lease_id: string | null
  context: ColumnType<Record<string, unknown>, string | undefined, string>
  created_at: CreatedAt
  updated_at: UpdatedAt
  finished_at: Date | null
}

export interface OutboxMessageTable {
  id: string
  topic: string
  payload: ColumnType<Record<string, unknown>, string, never>
  available_at: ColumnType<Date, Date | undefined, never>
  created_at: CreatedAt
  published_at: Date | null
}

export interface IdempotencyRecordTable {
  scope: string
  key: string
  request_hash: string
  status_code: number
  response: ColumnType<unknown, string, string>
  created_at: CreatedAt
}

export interface DestinationWebhookTable {
  destination_id: string
  secret_sealed: Uint8Array
  notification_id: string | null
  endpoint: string | null
  error: string | null
  registered_at: Date | null
  updated_at: UpdatedAt
}

export interface WebhookInboxTable {
  dedup_key: string
  destination_id: string
  application_name: string
  status: string
  received_at: CreatedAt
}
