import { SyncCatalog } from '../modules/catalog/application/sync-catalog'
import { CatalogError } from '../modules/catalog/domain/catalog'
import { FilesystemCatalogSource } from '../modules/catalog/infrastructure/filesystem-catalog.source'
import { PostgresCatalogRepository } from '../modules/catalog/infrastructure/postgres-catalog.repository'
import { AuditLog } from '../shared/audit/audit'
import { loadDatabaseConfig } from '../shared/config/config'
import { createDb } from '../shared/database/database'
import { UnitOfWork } from '../shared/database/unit-of-work'

/**
 * Синхронизировать каталог роботов: `bun run catalog:sync [dir]`. Каталог по умолчанию — `../bots`
 * (или BOTS_CATALOG_DIR). Битый манифест отклоняет всю синхронизацию: каталог не обновляется наполовину.
 */
const dir = process.argv[2] ?? process.env.BOTS_CATALOG_DIR ?? new URL('../../../bots', import.meta.url).pathname
const db = createDb(loadDatabaseConfig().DATABASE_URL, { max: 1 })
const unitOfWork = new UnitOfWork(db)

try {
  const sync = new SyncCatalog(
    new FilesystemCatalogSource(dir),
    new PostgresCatalogRepository(unitOfWork),
    unitOfWork,
    new AuditLog(unitOfWork),
  )
  const report = await sync.execute('system:cli')
  for (const item of report.added) console.log(`added     ${item.templateId} ${item.version.slice(0, 12)}`)
  for (const id of report.unchanged) console.log(`unchanged ${id}`)
  for (const id of report.retired) console.log(`retired   ${id}`)
} catch (error) {
  console.error(error instanceof CatalogError ? `${error.code}: ${error.message}` : error)
  process.exitCode = 1
} finally {
  await db.destroy()
}
