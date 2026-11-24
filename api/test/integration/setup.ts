import { afterAll } from 'bun:test'
import { sql } from 'kysely'
import { loadConfig } from '../../src/shared/config/config'
import { createDb, type Db } from '../../src/shared/database/database'
import { migrateToLatest } from '../../src/shared/database/migrate'

/**
 * Интеграционные тесты пересоздают схему. Чтобы ошибка в окружении не стёрла dev-данные,
 * работа разрешена только с базой, имя которой кончается на `_test`.
 */
const config = loadConfig()
const database = new URL(config.DATABASE_URL).pathname.slice(1)
if (!database.endsWith('_test')) {
  throw new Error(`integration tests refuse to run against "${database}": database name must end with _test`)
}

export const testConfig = config
export const db: Db = createDb(config.DATABASE_URL, { max: 4 })

await sql`DROP SCHEMA public CASCADE`.execute(db)
await sql`CREATE SCHEMA public`.execute(db)
const { error } = await migrateToLatest(db)
if (error) throw error

afterAll(async () => {
  await db.destroy()
})
