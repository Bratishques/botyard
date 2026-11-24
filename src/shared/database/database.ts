import { Kysely, PostgresDialect, sql } from 'kysely'
import pg from 'pg'
import type { Database } from './schema'

export type Db = Kysely<Database>

export const DB = Symbol('DB')

// bigint из Postgres приходит строкой: так он не теряет точность, а числом его делает место, которому это нужно
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => value)

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
