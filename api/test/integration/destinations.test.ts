import { beforeEach, describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { sql } from 'kysely'
import { DestinationSecrets } from '../../src/modules/destinations/application/destination-secrets'
import { DestinationUseCases } from '../../src/modules/destinations/application/destination-use-cases'
import { DestinationErrorCode } from '../../src/modules/destinations/domain/destination'
import type { DokployCatalog } from '../../src/modules/destinations/domain/ports'
import { KyselyDestinationRepository } from '../../src/modules/destinations/infrastructure/kysely-destination.repository'
import { AuditLog } from '../../src/shared/audit/audit'
import { loadConfig } from '../../src/shared/config/config'
import { LocalKeyEncryptionKey } from '../../src/shared/crypto/key-encryption-key'
import { SecretBox } from '../../src/shared/crypto/secret-box'
import { UnitOfWork } from '../../src/shared/database/unit-of-work'
import { DokployUnauthorizedError, DokployUnavailableError } from '../../src/shared/dokploy/dokploy.errors'
import { db } from './setup'

/**
 * Каталог Dokploy-заглушка: принимает один ключ, знает одно окружение и один сервер.
 * `gate` позволяет остановить вызов посреди сценария и выполнить конфликтующую операцию.
 */
class FakeCatalog implements DokployCatalog {
  validKey = 'valid-key-0123456789abcdef'
  down = false
  gate: Promise<void> | null = null
  calls = 0

  async environments(_baseUrl: string, apiKey: string) {
    this.calls++
    if (this.gate) await this.gate
    if (this.down) throw new DokployUnavailableError('dokploy project.all: 503')
    if (apiKey !== this.validKey) throw new DokployUnauthorizedError('dokploy project.all: 401 Unauthorized')
    return [{ projectId: 'prj_1', environmentId: 'env_1', name: 'botyard / production' }]
  }

  async servers(_baseUrl: string, apiKey: string) {
    if (apiKey !== this.validKey) throw new DokployUnauthorizedError('dokploy server.all: 401 Unauthorized')
    return [{ serverId: 'srv_1', name: 'bots-eu-1' }]
  }
}

const config = loadConfig({ ...process.env, DESTINATIONS_ALLOW_HTTP: 'false' })
const unitOfWork = new UnitOfWork(db)
const box = new SecretBox([new LocalKeyEncryptionKey(1, randomBytes(32))])
let catalog: FakeCatalog
let useCases: DestinationUseCases

const input = (overrides: Record<string, unknown> = {}) => ({
  name: `prod-${crypto.randomUUID().slice(0, 8)}`,
  baseUrl: `https://dokploy-${crypto.randomUUID().slice(0, 8)}.example.com/`,
  apiKey: 'valid-key-0123456789abcdef',
  environmentId: 'env_1',
  serverId: null,
  ...overrides,
})

async function codeOf(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work
    return undefined
  } catch (error) {
    return (error as { code?: string }).code
  }
}

beforeEach(async () => {
  catalog = new FakeCatalog()
  useCases = new DestinationUseCases(
    new KyselyDestinationRepository(unitOfWork),
    catalog,
    config,
    new DestinationSecrets(box),
    unitOfWork,
    new AuditLog(unitOfWork),
  )
})

describe('создание назначения', () => {
  test('нормализует адрес, берёт проект из окружения, хранит ключ только конвертом и пишет аудит', async () => {
    const created = await useCases.create(input({ name: '  Main Prod  ', baseUrl: 'https://Dokploy-A.example.com:443/' }), 'operator:1')

    expect(created).toMatchObject({
      name: 'Main Prod',
      baseUrl: 'https://dokploy-a.example.com',
      projectId: 'prj_1',
      status: 'ACTIVE',
      version: 1,
    })
    expect(created.apiKeyHint).toBe('••••cdef')

    const raw = await db.selectFrom('destination').select('api_key_sealed').where('id', '=', created.id).executeTakeFirstOrThrow()
    expect(Buffer.from(raw.api_key_sealed).includes(Buffer.from('valid-key'))).toBe(false)

    const audit = await db.selectFrom('audit_event').select(['action', 'payload']).where('target_id', '=', created.id).execute()
    expect(audit).toHaveLength(1)
    expect(audit[0]?.action).toBe('destination.created')
    expect(JSON.stringify(audit)).not.toContain('valid-key')
  })

  test('неверный ключ, несуществующее окружение или сервер, лежащий Dokploy — понятный код и ничего не записано', async () => {
    const before = await db.selectFrom('destination').select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow()

    expect(await codeOf(useCases.create(input({ apiKey: 'wrong-key' }), 'operator:1'))).toBe(DestinationErrorCode.KEY_REJECTED)
    expect(await codeOf(useCases.create(input({ environmentId: 'env_x' }), 'operator:1'))).toBe(DestinationErrorCode.ENVIRONMENT_NOT_FOUND)
    expect(await codeOf(useCases.create(input({ serverId: 'srv_x' }), 'operator:1'))).toBe(DestinationErrorCode.SERVER_NOT_FOUND)
    catalog.down = true
    expect(await codeOf(useCases.create(input(), 'operator:1'))).toBe(DestinationErrorCode.UNREACHABLE)
    expect(await codeOf(useCases.create(input({ baseUrl: 'http://plain.example.com' }), 'operator:1'))).toBe(
      DestinationErrorCode.INSECURE_URL,
    )

    const after = await db.selectFrom('destination').select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow()
    expect(after.n).toBe(before.n)
  })

  test('гонка: два одновременных создания с одним именем — проходит одно, второе получает NAME_TAKEN', async () => {
    const name = `race-${crypto.randomUUID().slice(0, 8)}`
    const results = await Promise.allSettled([
      useCases.create(input({ name }), 'operator:1'),
      useCases.create(input({ name }), 'operator:2'),
    ])

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult
    expect((rejected.reason as { code?: string }).code).toBe(DestinationErrorCode.NAME_TAKEN)
  })

  test('один и тот же Dokploy в разных написаниях — TARGET_TAKEN', async () => {
    await useCases.create(input({ baseUrl: 'https://same.example.com' }), 'operator:1')

    expect(await codeOf(useCases.create(input({ baseUrl: 'https://SAME.example.com.:443/' }), 'operator:1'))).toBe(
      DestinationErrorCode.TARGET_TAKEN,
    )
  })
})

describe('правка назначения', () => {
  test('правка по устаревшей версии — VERSION_CONFLICT; гонка двух правок — проходит одна', async () => {
    const created = await useCases.create(input(), 'operator:1')

    const results = await Promise.allSettled([
      useCases.update(created.id, { version: 1, name: `a-${created.id.slice(-6)}` }, 'operator:1'),
      useCases.update(created.id, { version: 1, name: `b-${created.id.slice(-6)}` }, 'operator:2'),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(((results.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason as { code: string }).code).toBe(
      DestinationErrorCode.VERSION_CONFLICT,
    )
    expect((await useCases.get(created.id)).version).toBe(2)
  })

  test('смена адреса без нового ключа запрещена; с ключом — конверт перепривязан к новому адресу', async () => {
    const created = await useCases.create(input(), 'operator:1')
    const newUrl = `https://moved-${created.id.slice(-6)}.example.com`

    expect(await codeOf(useCases.update(created.id, { version: 1, baseUrl: newUrl }, 'operator:1'))).toBe(DestinationErrorCode.KEY_REQUIRED)

    const moved = await useCases.update(created.id, { version: 1, baseUrl: newUrl, apiKey: catalog.validKey }, 'operator:1')
    const secrets = new DestinationSecrets(box)
    expect(await secrets.open(moved.id, newUrl, moved.apiKeySealed)).toBe(catalog.validKey)
    await expect(secrets.open(moved.id, created.baseUrl, moved.apiKeySealed)).rejects.toThrow()
  })

  test('правка без изменений не трогает версию и не пишет аудит', async () => {
    const created = await useCases.create(input(), 'operator:1')

    expect((await useCases.update(created.id, { version: 1, name: created.name }, 'operator:1')).version).toBe(1)
    const audit = await db.selectFrom('audit_event').select('action').where('target_id', '=', created.id).execute()
    expect(audit.map((row) => row.action)).toEqual(['destination.created'])
  })
})

describe('проверка связи', () => {
  test('лежащий Dokploy — UNREACHABLE с причиной, поднявшийся — снова ACTIVE', async () => {
    const created = await useCases.create(input(), 'operator:1')

    catalog.down = true
    const down = await useCases.check(created.id, 'operator:1')
    expect(down.status).toBe('UNREACHABLE')
    expect(down.lastError).toContain(DestinationErrorCode.UNREACHABLE)

    catalog.down = false
    expect((await useCases.check(created.id, 'operator:1')).status).toBe('ACTIVE')
  })

  test('гонка: правка ключа во время проверки — результат проверки старого ключа не записывается', async () => {
    const created = await useCases.create(input(), 'operator:1')
    let release: () => void = () => {}
    catalog.gate = new Promise((resolve) => (release = resolve))
    catalog.down = true

    const checking = useCases.check(created.id, 'operator:1')
    await Bun.sleep(5)
    catalog.gate = null
    catalog.down = false
    const renamed = await useCases.update(created.id, { version: 1, name: `renamed-${created.id.slice(-6)}` }, 'operator:2')
    catalog.down = true
    release()

    const afterCheck = await checking
    expect(afterCheck.version).toBe(renamed.version)
    expect(afterCheck.status).toBe('ACTIVE')
    expect(afterCheck.lastError).toBeNull()
  })

  test('выключенное назначение проверка не включает', async () => {
    const created = await useCases.create(input(), 'operator:1')
    await useCases.setEnabled(created.id, 1, false, 'operator:1')

    expect((await useCases.check(created.id, 'operator:1')).status).toBe('DISABLED')
  })
})
