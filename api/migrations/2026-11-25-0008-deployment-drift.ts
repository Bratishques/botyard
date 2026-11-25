import { type Kysely, sql } from 'kysely'

/**
 * Дрейф развёртывания относительно Dokploy: робота остановили, запустили или удалили руками в Dokploy, либо его
 * передеплой там упал. Это наблюдение reconciler'а, а не статус: статус развёртывания не меняется, оператор видит
 * расхождение и решает сам. `drift_checked_at` — когда сверяли в последний раз (сверка не чаще раза в 5 мин).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE bot_deployment
      ADD COLUMN drift text CHECK (drift IN ('APP_MISSING', 'STOPPED_IN_DOKPLOY', 'RUNNING_IN_DOKPLOY', 'FAILED_IN_DOKPLOY')),
      ADD COLUMN drift_checked_at timestamptz
  `.execute(db)
  await sql`
    CREATE INDEX bot_deployment_drift_check_idx ON bot_deployment (drift_checked_at NULLS FIRST)
    WHERE active_operation_id IS NULL AND status IN ('RUNNING', 'STOPPED', 'FAILED')
  `.execute(db)
}
