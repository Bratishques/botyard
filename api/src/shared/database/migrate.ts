import { promises as fs } from 'node:fs'
import path from 'node:path'
import { FileMigrationProvider, type MigrationResultSet, Migrator } from 'kysely/migration'
import type { Db } from './database'

export const MIGRATIONS_DIR = path.resolve(import.meta.dir, '../../../migrations')

/**
 * Миграции только вперёд. `down` в файлах есть для локальной отладки, но в процессе деплоя
 * не вызывается: откат схемы на живых данных — отдельное решение, а не кнопка.
 */
export async function migrateToLatest(db: Db): Promise<MigrationResultSet> {
  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({ fs, path, migrationFolder: MIGRATIONS_DIR }),
  })

  return migrator.migrateToLatest()
}
