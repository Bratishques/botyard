import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { sql } from 'kysely'
import { SyncCatalog } from '../../src/modules/catalog/application/sync-catalog'
import { FilesystemCatalogSource } from '../../src/modules/catalog/infrastructure/filesystem-catalog.source'
import { PostgresCatalogRepository } from '../../src/modules/catalog/infrastructure/postgres-catalog.repository'
import { AuditLog } from '../../src/shared/audit/audit'
import { loadCatalogConfig } from '../../src/shared/config/config'
import { UnitOfWork } from '../../src/shared/database/unit-of-work'
import { db } from './setup'

/** Каталог синхронизируется из копии репозитория bots во временной папке: её можно портить */
const BOTS = loadCatalogConfig().BOTS_CATALOG_DIR
const unitOfWork = new UnitOfWork(db)
const repository = new PostgresCatalogRepository(unitOfWork)
let dir: string

const syncFrom = (from: string, options: { allowEmpty?: boolean } = {}) =>
  new SyncCatalog(new FilesystemCatalogSource(from), repository, unitOfWork, new AuditLog(unitOfWork)).execute('system:test', options)

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

afterEach(async () => {
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

  test('откат манифеста на известную версию — переключение в отчёте и аудите', async () => {
    const [original] = (await sync()).added.filter((item) => item.templateId === 'bita')
    await editManifest('bita', (manifest) => {
      ;(manifest.upstream as Record<string, unknown>).ref = 'v2'
    })
    const [changed] = (await sync()).added
    await editManifest('bita', (manifest) => {
      ;(manifest.upstream as Record<string, unknown>).ref = 'main'
    })

    const rollback = await sync()
    expect(rollback.switched).toEqual([{ templateId: 'bita', from: changed?.version ?? '', to: original?.version ?? '' }])
    const audit = await sql<{
      n: number
    }>`SELECT count(*)::int AS n FROM audit_event WHERE action = 'catalog.synced' AND payload->'switched' != '[]'::jsonb`.execute(db)
    expect(audit.rows[0]?.n).toBeGreaterThan(0)
  })

  test('вернувшийся шаблон снова действует и попадает в отчёт', async () => {
    const backup = await mkdtemp(path.join(tmpdir(), 'botyard-catalog-backup-'))
    await sync()
    await cp(path.join(dir, 'templates', 'bita'), path.join(backup, 'bita'), { recursive: true })
    await rm(path.join(dir, 'templates', 'bita'), { recursive: true })
    await sync()
    await cp(path.join(backup, 'bita'), path.join(dir, 'templates', 'bita'), { recursive: true })
    await rm(backup, { recursive: true, force: true })

    expect((await sync()).restored).toEqual(['bita'])
    expect((await repository.list()).find((template) => template.id === 'bita')?.retired).toBe(false)
  })

  test('версию нельзя удалить', async () => {
    await sync()

    await expect(sql`DELETE FROM bot_template_version WHERE template_id = 'bita'`.execute(db)).rejects.toThrow('immutable')
  })

  test('симлинк на файл шаблона или на папку шаблона отклоняется', async () => {
    const outside = path.join(dir, 'outside.txt')
    await writeFile(outside, 'SECRET-OUTSIDE')
    await rm(path.join(dir, 'templates', 'contest-2022', 'config.toml.tpl'))
    await symlink(outside, path.join(dir, 'templates', 'contest-2022', 'config.toml.tpl'))

    await expect(sync()).rejects.toThrow('must not be a symlink')

    const fresh = await mkdtemp(path.join(tmpdir(), 'botyard-catalog-'))
    await cp(BOTS, fresh, { recursive: true })
    await rm(path.join(fresh, 'templates', 'bita'), { recursive: true })
    await symlink(path.join(BOTS, 'templates', 'bita'), path.join(fresh, 'templates', 'bita'))
    await expect(syncFrom(fresh)).rejects.toThrow('must not be a symlink')
    await rm(fresh, { recursive: true, force: true })
  })

  test('манифест с лишним полем и опечатка в схеме конфига — отказ', async () => {
    await editManifest('bita', (manifest) => {
      manifest.surprise = true
    })
    await expect(sync()).rejects.toMatchObject({ code: 'CATALOG_INVALID_MANIFEST' })

    await cp(path.join(BOTS, 'templates', 'bita', 'template.json'), path.join(dir, 'templates', 'bita', 'template.json'))
    await editManifest('bita', (manifest) => {
      ;(manifest.config as { schema: Record<string, unknown> }).schema.requird = ['figi']
    })
    await expect(sync()).rejects.toThrow('config.schema is not a valid JSON Schema')
  })

  test('пустой каталог отклоняется без явного разрешения', async () => {
    await sync()
    await rm(path.join(dir, 'templates'), { recursive: true })
    await cp(path.join(BOTS, 'schema'), path.join(dir, 'schema'), { recursive: true })
    await Bun.write(path.join(dir, 'templates', '.keep'), '')

    await expect(sync()).rejects.toThrow('catalog is empty')
    expect((await syncFrom(dir, { allowEmpty: true })).retired.sort()).toEqual(['bita', 'contest-2022'])
  })

  test('две синхронизации с разным содержимым одновременно — без взаимной блокировки даже при худшем переплетении', async () => {
    // Строки шаблонов уже есть: на их блокировках и строится взаимная блокировка
    await sync()
    const other = await mkdtemp(path.join(tmpdir(), 'botyard-catalog-'))
    await cp(BOTS, other, { recursive: true })
    await rm(path.join(other, 'templates', 'bita'), { recursive: true })

    // Переплетение из ревью: A записала bita и ждёт, пока B запишет contest-2022; затем A идёт к contest-2022,
    // а B — к выводу bita. Без блокировки синхронизации это взаимная блокировка строк
    let bWrote: () => void = () => {}
    const bWroteContest = new Promise<void>((resolve) => (bWrote = resolve))
    const gated = (onSet: (templateId: string) => Promise<void>) =>
      new (class extends PostgresCatalogRepository {
        override async setCurrent(templateId: string, version: string) {
          const result = await super.setCurrent(templateId, version)
          await onSet(templateId)
          return result
        }
      })(unitOfWork)
    const syncA = new SyncCatalog(
      new FilesystemCatalogSource(dir),
      gated(async (id) => {
        if (id === 'bita') await Promise.race([bWroteContest, Bun.sleep(300)])
      }),
      unitOfWork,
      new AuditLog(unitOfWork),
    )
    const syncB = new SyncCatalog(
      new FilesystemCatalogSource(other),
      gated(async (id) => {
        if (id === 'contest-2022') bWrote()
      }),
      unitOfWork,
      new AuditLog(unitOfWork),
    )

    const results = await Promise.allSettled([syncA.execute('system:a'), Bun.sleep(30).then(() => syncB.execute('system:b'))])
    await rm(other, { recursive: true, force: true })

    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled'])
  })
})
