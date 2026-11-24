import type { ColumnType, Generated } from 'kysely'
import type { TemplateManifest } from '../../modules/catalog/domain/catalog'

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
