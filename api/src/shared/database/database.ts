import { Kysely, PostgresDialect, sql } from 'kysely'
import pg from 'pg'
import type { Database } from './schema'

/** bigint (int8) драйвер pg отдаёт строкой: точность не теряется, числом его делает место, которому это нужно */
export type Db = Kysely<Database>

export const DB = Symbol('DB')

export interface DbOptions {
  max?: number
  /**
   * Postgres сам закроет сессию, простаивающую в открытой транзакции дольше этого: страховка процессов,
   * которые держат транзакцию на сетевом вызове (relay — на подтверждении брокера)
   */
  idleInTransactionTimeoutMs?: number
}

export function createDb(url: string, options: DbOptions = {}): Db {
  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({
        connectionString: url,
        // Реплик api может быть несколько: маленький пул на процесс, чтобы не выбрать max_connections
        max: options.max ?? 10,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 5_000,
        ...(options.idleInTransactionTimeoutMs !== undefined && {
          idle_in_transaction_session_timeout: options.idleInTransactionTimeoutMs,
        }),
      }),
    }),
  })
}

export async function pingDb(db: Db): Promise<void> {
  await sql`select 1`.execute(db)
}
