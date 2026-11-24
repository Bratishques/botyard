import { loadDatabaseConfig } from '../shared/config/config'
import { createDb } from '../shared/database/database'
import { migrateToLatest } from '../shared/database/migrate'

const config = loadDatabaseConfig()
const db = createDb(config.DATABASE_URL, { max: 1 })

try {
  const { error, results } = await migrateToLatest(db)
  for (const result of results ?? []) console.log(`${result.status.padEnd(7)} ${result.migrationName}`)
  if (error) {
    console.error('migration failed:', error)
    process.exitCode = 1
  } else if (!results?.length) {
    console.log('schema is up to date')
  }
} finally {
  await db.destroy()
}
