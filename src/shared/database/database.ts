import { Kysely, PostgresDialect, sql } from 'kysely'
import pg from 'pg'
import type { Database } from './schema'

/** bigint (int8) драйвер pg отдаёт строкой: точность не теряется, числом его делает место, которому это нужно */
export type Db = Kysely<Database>

export const DB = Symbol('DB')

export function createDb(url: string, options: { max?: number } = {}): Db {
  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({
        connectionString: url,
        // Реплик api может быть несколько: маленький пул на процесс, чтобы не выбрать max_connections
        max: options.max ?? 10,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 5_000,
      }),
    }),
  })
}

export async function pingDb(db: Db): Promise<void> {
  await sql`select 1`.execute(db)
}
