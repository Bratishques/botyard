import { SyncCatalog } from '../modules/catalog/application/sync-catalog'
import { CatalogError } from '../modules/catalog/domain/catalog'
import { FilesystemCatalogSource } from '../modules/catalog/infrastructure/filesystem-catalog.source'
import { PostgresCatalogRepository } from '../modules/catalog/infrastructure/postgres-catalog.repository'
import { AuditLog } from '../shared/audit/audit'
import { loadCatalogConfig, loadDatabaseConfig } from '../shared/config/config'
import { createDb } from '../shared/database/database'
import { UnitOfWork } from '../shared/database/unit-of-work'

/**
 * Синхронизировать каталог роботов: `bun run catalog:sync [dir]`. Каталог по умолчанию — `../bots`
 * (или BOTS_CATALOG_DIR). Битый манифест отклоняет всю синхронизацию: каталог не обновляется наполовину.
 */
const dirArgument = process.argv.slice(2).find((argument) => !argument.startsWith('--'))
const dir = dirArgument ?? loadCatalogConfig().BOTS_CATALOG_DIR
const db = createDb(loadDatabaseConfig().DATABASE_URL, { max: 1 })
const unitOfWork = new UnitOfWork(db)

try {
  const sync = new SyncCatalog(
    new FilesystemCatalogSource(dir),
    new PostgresCatalogRepository(unitOfWork),
    unitOfWork,
    new AuditLog(unitOfWork),
  )
  const report = await sync.execute('system:cli', { allowEmpty: process.argv.includes('--allow-empty') })
  for (const item of report.added) console.log(`added     ${item.templateId} ${item.version.slice(0, 12)}`)
  for (const item of report.switched) console.log(`switched  ${item.templateId} ${item.from.slice(0, 12)} → ${item.to.slice(0, 12)}`)
  for (const id of report.restored) console.log(`restored  ${id}`)
  for (const id of report.unchanged) console.log(`unchanged ${id}`)
  for (const id of report.retired) console.log(`retired   ${id}`)
} catch (error) {
  console.error(error instanceof CatalogError ? `${error.code}: ${error.message}` : error)
  process.exitCode = 1
} finally {
  await db.destroy()
}
