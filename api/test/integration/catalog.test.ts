import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { sql } from 'kysely'
import { SyncCatalog } from '../../src/modules/catalog/application/sync-catalog'
import { FilesystemCatalogSource } from '../../src/modules/catalog/infrastructure/filesystem-catalog.source'
import { PostgresCatalogRepository } from '../../src/modules/catalog/infrastructure/postgres-catalog.repository'
import { AuditLog } from '../../src/shared/audit/audit'
import { UnitOfWork } from '../../src/shared/database/unit-of-work'
import { db } from './setup'

/** Каталог синхронизируется из копии репозитория bots во временной папке: её можно портить */
const BOTS = new URL('../../../bots', import.meta.url).pathname
const unitOfWork = new UnitOfWork(db)
const repository = new PostgresCatalogRepository(unitOfWork)
let dir: string

const sync = () =>
  new SyncCatalog(new FilesystemCatalogSource(dir), repository, unitOfWork, new AuditLog(unitOfWork)).execute('system:test')

async function editManifest(id: string, edit: (manifest: Record<string, unknown>) => void): Promise<void> {
  const file = path.join(dir, 'templates', id, 'template.json')
  const manifest = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
  edit(manifest)
  await writeFile(file, JSON.stringify(manifest, null, 2))
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'botyard-catalog-'))
  await cp(BOTS, dir, { recursive: true })
  // Тесты каталога начинают с пустого каталога; TRUNCATE версий триггер неизменности не запрещает (он на строки)
  await sql`TRUNCATE bot_template_version, bot_template`.execute(db)
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('синхронизация каталога', () => {
  test('загружает шаблоны репозитория; повтор ничего не пишет', async () => {
    const first = await sync()
    expect(first.added.map((item) => item.templateId).sort()).toEqual(['bita', 'contest-2022'])

    const second = await sync()
    expect(second.added).toEqual([])
    expect(second.unchanged.sort()).toEqual(['bita', 'contest-2022'])

    const templates = await repository.list()
    expect(templates.find((template) => template.id === 'contest-2022')?.delivery).toBe('file')
  })

  test('правка манифеста — новая версия; старая остаётся и неизменна', async () => {
    const [before] = (await sync()).added.filter((item) => item.templateId === 'bita')
    await editManifest('bita', (manifest) => {
      ;(manifest.upstream as Record<string, unknown>).ref = 'v2'
    })
    const [after] = (await sync()).added

    expect(after?.version).not.toBe(before?.version)
    expect((await repository.list()).find((template) => template.id === 'bita')?.currentVersion).toBe(after?.version)
    expect(await repository.findVersion('bita', before?.version ?? '')).not.toBeNull()
    await expect(sql`UPDATE bot_template_version SET name = 'x' WHERE template_id = 'bita'`.execute(db)).rejects.toThrow('immutable')
  })

  test('исчезнувший шаблон помечается выведенным, но не удаляется', async () => {
    await sync()
    await rm(path.join(dir, 'templates', 'bita'), { recursive: true })

    expect((await sync()).retired).toEqual(['bita'])
    expect((await repository.list()).find((template) => template.id === 'bita')?.retired).toBe(true)
  })

  test('битый манифест или битая схема конфига отклоняют всю синхронизацию', async () => {
    await sync()
    const before = await repository.list()

    await editManifest('bita', (manifest) => {
      ;(manifest.upstream as Record<string, unknown>).ref = 'v3'
    })
    await editManifest('contest-2022', (manifest) => {
      ;(manifest.config as Record<string, unknown>).schema = { type: 'not-a-type' }
    })

    await expect(sync()).rejects.toMatchObject({ code: 'CATALOG_INVALID_MANIFEST' })
    expect(await repository.list()).toEqual(before)
  })

  test('id манифеста обязан совпадать с папкой', async () => {
    await editManifest('bita', (manifest) => {
      manifest.id = 'other'
    })

    await expect(sync()).rejects.toThrow('does not match the folder name')
  })
})
