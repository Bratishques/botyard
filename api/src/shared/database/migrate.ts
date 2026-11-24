import { promises as fs } from 'node:fs'
import path from 'node:path'
import { FileMigrationProvider, type MigrationResultSet, Migrator } from 'kysely/migration'
import type { Db } from './database'

export const MIGRATIONS_DIR = path.resolve(import.meta.dir, '../../../migrations')

/**
 * Миграции только вперёд, `down` в файлах нет: откат схемы на живых данных — отдельное решение,
 * а не кнопка. Применённую миграцию не правят: Kysely сверяет только имена файлов, и база,
 * накатанная старой версией, молча останется без изменений.
 */
export async function migrateToLatest(db: Db): Promise<MigrationResultSet> {
  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({ fs, path, migrationFolder: MIGRATIONS_DIR }),
  })

  return migrator.migrateToLatest()
}
