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
  rateLimited = false
  gate: Promise<void> | null = null
  calls = 0
  projectOf = new Map<string, string>()

  async environments(_baseUrl: string, apiKey: string) {
    this.calls++
    if (this.gate) await this.gate
    if (this.down) throw new DokployUnavailableError('dokploy project.all: 503')
    if (this.rateLimited) throw new DokployUnavailableError('dokploy project.all: 429 Rate limit exceeded', 86_345_000)
    if (apiKey !== this.validKey) throw new DokployUnauthorizedError('dokploy project.all: 401 Unauthorized')
    return [...environments].map((environmentId) => ({
      projectId: this.projectOf.get(environmentId) ?? 'prj_1',
      environmentId,
      name: `botyard / ${environmentId}`,
    }))
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

/** Окружения, которые «существуют» в заглушке Dokploy: у каждого тестового назначения своё */
const environments = new Set<string>()
function freshEnvironment(): string {
  const id = `env_${crypto.randomUUID().slice(0, 12)}`
  environments.add(id)
  return id
}

const input = (overrides: Record<string, unknown> = {}) => ({
  name: `prod-${crypto.randomUUID().slice(0, 8)}`,
  baseUrl: `https://dokploy-${crypto.randomUUID().slice(0, 8)}.example.com/`,
  apiKey: 'valid-key-0123456789abcdef',
  environmentId: freshEnvironment(),
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
    catalog.rateLimited = true
    expect(await codeOf(useCases.create(input(), 'operator:1'))).toBe(DestinationErrorCode.RATE_LIMITED)
    catalog.rateLimited = false
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

  test('одно окружение Dokploy под разными адресами (написания и псевдонимы) — TARGET_TAKEN, в том числе в гонке', async () => {
    const environmentId = freshEnvironment()
    await useCases.create(input({ baseUrl: 'https://same.example.com', environmentId }), 'operator:1')

    expect(await codeOf(useCases.create(input({ baseUrl: 'https://SAME.example.com.:443/', environmentId }), 'operator:1'))).toBe(
      DestinationErrorCode.TARGET_TAKEN,
    )
    expect(await codeOf(useCases.create(input({ baseUrl: 'https://203.0.113.7', environmentId }), 'operator:1'))).toBe(
      DestinationErrorCode.TARGET_TAKEN,
    )

    const racing = freshEnvironment()
    const results = await Promise.allSettled([
      useCases.create(input({ environmentId: racing }), 'operator:1'),
      useCases.create(input({ environmentId: racing }), 'operator:2'),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
  })

  test('аудит атомарен с изменением: упавшая запись аудита откатывает создание', async () => {
    const failingAudit = new (class extends AuditLog {
      override async record(): Promise<void> {
        throw new Error('audit is down')
      }
    })(unitOfWork)
    const withBrokenAudit = new DestinationUseCases(
      new KyselyDestinationRepository(unitOfWork),
      catalog,
      config,
      new DestinationSecrets(box),
      unitOfWork,
      failingAudit,
    )
    const name = `atomic-${crypto.randomUUID().slice(0, 8)}`

    await expect(withBrokenAudit.create(input({ name }), 'operator:1')).rejects.toThrow('audit is down')
    const leftovers = await db.selectFrom('destination').select('id').where('name', '=', name).execute()
    expect(leftovers).toHaveLength(0)
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

  test('правка выключенного назначения его не включает', async () => {
    const created = await useCases.create(input(), 'operator:1')
    const disabled = await useCases.setEnabled(created.id, 1, false, 'operator:1')

    const moved = await useCases.update(created.id, { version: disabled.version, environmentId: freshEnvironment() }, 'operator:1')
    expect(moved.status).toBe('DISABLED')
    const rekeyed = await useCases.update(created.id, { version: moved.version, apiKey: catalog.validKey }, 'operator:1')
    expect(rekeyed.status).toBe('DISABLED')
  })

  test('новое окружение берёт свой проект; аудит перечисляет только изменённые поля', async () => {
    const created = await useCases.create(input(), 'operator:1')
    const environmentId = freshEnvironment()
    catalog.projectOf.set(environmentId, 'prj_other')

    const moved = await useCases.update(created.id, { version: 1, environmentId }, 'operator:1')
    expect(moved.projectId).toBe('prj_other')

    const audit = await db
      .selectFrom('audit_event')
      .select('payload')
      .where('target_id', '=', created.id)
      .where('action', '=', 'destination.updated')
      .executeTakeFirstOrThrow()
    expect((audit.payload as { fields: string[] }).fields.sort()).toEqual(['environmentId', 'projectId'])
  })

  test('повторное выключение — без изменений: версия не растёт, аудита нет', async () => {
    const created = await useCases.create(input(), 'operator:1')
    const disabled = await useCases.setEnabled(created.id, 1, false, 'operator:1')
    const again = await useCases.setEnabled(created.id, disabled.version, false, 'operator:2')

    expect(again.version).toBe(disabled.version)
    const audit = await db.selectFrom('audit_event').select('action').where('target_id', '=', created.id).execute()
    expect(audit.map((row) => row.action)).toEqual(['destination.created', 'destination.disabled'])
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
    const renamed = await useCases.update(created.id, { version: 1, apiKey: catalog.validKey }, 'operator:2')
    catalog.down = true
    release()

    const afterCheck = await checking
    expect(afterCheck.version).toBe(renamed.version)
    expect(afterCheck.status).toBe('ACTIVE')
    expect(afterCheck.lastError).toBeNull()
  })

  test('гонка: выключение во время проверки — результат проверки не записывается, назначение остаётся выключенным', async () => {
    const created = await useCases.create(input(), 'operator:1')
    let release: () => void = () => {}
    catalog.gate = new Promise((resolve) => (release = resolve))

    const checking = useCases.check(created.id, 'operator:1')
    await Bun.sleep(5)
    catalog.gate = null
    await useCases.setEnabled(created.id, 1, false, 'operator:2')
    release()

    expect((await checking).status).toBe('DISABLED')
  })

  test('из двух проверок остаётся более свежая по моменту ответа Dokploy', async () => {
    const created = await useCases.create(input(), 'operator:1')
    const repository = new KyselyDestinationRepository(unitOfWork)
    const newer = new Date()
    const older = new Date(newer.getTime() - 1_000)

    await repository.recordCheck(created.id, 1, { status: 'ACTIVE', error: null, checkedAt: newer })
    const stale = await repository.recordCheck(created.id, 1, { status: 'UNREACHABLE', error: 'late', checkedAt: older })

    expect(stale).toBeNull()
    expect((await useCases.get(created.id)).status).toBe('ACTIVE')
  })

  test('выключенное назначение проверка не включает', async () => {
    const created = await useCases.create(input(), 'operator:1')
    await useCases.setEnabled(created.id, 1, false, 'operator:1')

    expect((await useCases.check(created.id, 'operator:1')).status).toBe('DISABLED')
  })
})
