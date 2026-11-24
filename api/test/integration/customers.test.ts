import { describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { CustomerUseCases } from '../../src/modules/customers/application/customer-use-cases'
import { type Customer, type CustomerChanges, CustomerErrorCode } from '../../src/modules/customers/domain/customer'
import { PostgresCustomerRepository } from '../../src/modules/customers/infrastructure/postgres-customer.repository'
import { AuditLog } from '../../src/shared/audit/audit'
import { LocalKeyEncryptionKey } from '../../src/shared/crypto/key-encryption-key'
import { SecretBox } from '../../src/shared/crypto/secret-box'
import { UnitOfWork } from '../../src/shared/database/unit-of-work'
import { db } from './setup'

const unitOfWork = new UnitOfWork(db)
const box = new SecretBox([new LocalKeyEncryptionKey(1, randomBytes(32))])
const repository = new PostgresCustomerRepository(unitOfWork)
const customers = new CustomerUseCases(repository, box, unitOfWork, new AuditLog(unitOfWork))

const SANDBOX_TOKEN = 't.sandbox-token-0123456789abcdef'
const LIVE_TOKEN = 't.live-token-0123456789abcdefghij'
const SANDBOX_ACCOUNT = 'a1b2c3d4-sandbox'
const LIVE_ACCOUNT = '2000123456'

const input = (overrides: Record<string, unknown> = {}) => ({
  name: `client-${crypto.randomUUID().slice(0, 8)}`,
  accountId: SANDBOX_ACCOUNT,
  token: SANDBOX_TOKEN,
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

/**
 * Принудительное переплетение: запись в хранилище ждёт, пока до неё дойдут все `participants` — каждый
 * успел прочитать основание до того, как кто-то записал. Проигравшего тогда отсекает именно условная
 * запись по версии, а не ранняя проверка.
 */
function gated(participants: number): CustomerUseCases {
  let arrived = 0
  let open: () => void = () => {}
  const barrier = new Promise<void>((resolve) => (open = resolve))
  const gatedRepository = new (class extends PostgresCustomerRepository {
    override async update(id: string, expectedVersion: number, changes: CustomerChanges): Promise<Customer | null> {
      arrived++
      if (arrived >= participants) open()
      await Promise.race([barrier, Bun.sleep(2_000)])
      return super.update(id, expectedVersion, changes)
    }
  })(unitOfWork)

  return new CustomerUseCases(gatedRepository, box, unitOfWork, new AuditLog(unitOfWork))
}

async function actions(id: string): Promise<string[]> {
  const rows = await db.selectFrom('audit_event').select('action').where('target_id', '=', id).orderBy('created_at').execute()
  return rows.map((row) => row.action)
}

const toLive = (version: number, confirmName: string) => ({ version, token: LIVE_TOKEN, accountId: LIVE_ACCOUNT, confirmName })

describe('клиенты', () => {
  test('создаётся в песочнице; токен хранится только конвертом; аудит без токена', async () => {
    const created = await customers.create(input(), 'operator:1')

    expect(created.sandbox).toBe(true)
    expect(created.tokenHint).toBe('••••cdef')
    const raw = await db.selectFrom('customer').select('tinvest_token_sealed').where('id', '=', created.id).executeTakeFirstOrThrow()
    expect(Buffer.from(raw.tinvest_token_sealed).includes(Buffer.from('sandbox-token'))).toBe(false)
    expect(await customers.revealToken(created)).toBe(SANDBOX_TOKEN)
    const audit = await db.selectFrom('audit_event').select('payload').where('target_id', '=', created.id).execute()
    expect(JSON.stringify(audit)).not.toContain('sandbox-token')
  })

  test('боевой режим — точное имя, новый токен и боевой счёт; обратно — токен и счёт песочницы', async () => {
    const created = await customers.create(input(), 'operator:1')

    expect(await codeOf(customers.goLive(created.id, toLive(1, 'wrong'), 'operator:1'))).toBe(CustomerErrorCode.LIVE_CONFIRMATION_REQUIRED)
    const live = await customers.goLive(created.id, toLive(1, created.name), 'operator:1')
    expect(live).toMatchObject({ sandbox: false, accountId: LIVE_ACCOUNT })
    expect(await customers.revealToken(live)).toBe(LIVE_TOKEN)
    expect(await codeOf(customers.goLive(created.id, toLive(live.version, created.name), 'operator:1'))).toBe(
      CustomerErrorCode.ALREADY_IN_MODE,
    )

    const back = await customers.goSandbox(
      created.id,
      { version: live.version, token: SANDBOX_TOKEN, accountId: SANDBOX_ACCOUNT },
      'operator:1',
    )
    expect(back).toMatchObject({ sandbox: true, accountId: SANDBOX_ACCOUNT })
    expect(await customers.revealToken(back)).toBe(SANDBOX_TOKEN)
    expect(await actions(created.id)).toEqual(['customer.created', 'customer.live_enabled', 'customer.sandbox_enabled'])
  })

  test('ротация токена в боевом режиме остаётся боевой', async () => {
    const created = await customers.create(input(), 'operator:1')
    const live = await customers.goLive(created.id, toLive(1, created.name), 'operator:1')
    const rotated = await customers.rotateToken(
      created.id,
      { version: live.version, token: 't.new-live-token-0123456789abc' },
      'operator:1',
    )

    expect(await customers.revealToken(rotated)).toBe('t.new-live-token-0123456789abc')
  })

  test('смена счёта боевого клиента — только с подтверждением именем; в песочнице — без', async () => {
    const created = await customers.create(input(), 'operator:1')
    const moved = await customers.update(created.id, { version: 1, accountId: 'other-sandbox' }, 'operator:1')
    const live = await customers.goLive(created.id, toLive(moved.version, created.name), 'operator:1')

    expect(await codeOf(customers.update(created.id, { version: live.version, accountId: '2000999999' }, 'operator:1'))).toBe(
      CustomerErrorCode.LIVE_CONFIRMATION_REQUIRED,
    )
    const confirmed = await customers.update(
      created.id,
      { version: live.version, accountId: '2000999999', confirmName: created.name },
      'operator:1',
    )
    expect(confirmed.accountId).toBe('2000999999')
  })

  test('переключение режима в базе в обход сценария не делает токен песочницы боевым', async () => {
    const created = await customers.create(input(), 'operator:1')
    await db.updateTable('customer').set({ sandbox: false }).where('id', '=', created.id).execute()

    await expect(customers.revealToken(await customers.get(created.id))).rejects.toThrow()
  })

  describe('гонки (принудительное переплетение)', () => {
    test('двойной перевод в боевой режим — проходит один, событие одно', async () => {
      const created = await customers.create(input(), 'operator:1')
      const racing = gated(2)

      const results = await Promise.allSettled([
        racing.goLive(created.id, toLive(1, created.name), 'operator:1'),
        racing.goLive(created.id, toLive(1, created.name), 'operator:2'),
      ])
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
      expect((await actions(created.id)).filter((action) => action === 'customer.live_enabled')).toHaveLength(1)
    })

    test('боевой режим против ротации токена — режим и конверт из одной записи', async () => {
      const created = await customers.create(input(), 'operator:1')
      const racing = gated(2)

      const results = await Promise.allSettled([
        racing.goLive(created.id, toLive(1, created.name), 'operator:1'),
        racing.rotateToken(created.id, { version: 1, token: 't.other-sandbox-token-0123456789' }, 'operator:2'),
      ])
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
      expect(await customers.revealToken(await customers.get(created.id))).toBeString()
    })

    test('боевой режим, архив и правка одновременно — проходит одно действие', async () => {
      const created = await customers.create(input(), 'operator:1')
      const racing = gated(3)

      const results = await Promise.allSettled([
        racing.goLive(created.id, toLive(1, created.name), 'operator:1'),
        racing.archive(created.id, 1, 'operator:2'),
        racing.update(created.id, { version: 1, accountId: 'third' }, 'operator:3'),
      ])
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
      expect((await customers.get(created.id)).version).toBe(2)
    })

    test('создание с одним именем в разном регистре — один клиент', async () => {
      const name = `race-${crypto.randomUUID().slice(0, 8)}`
      const results = await Promise.allSettled([
        customers.create(input({ name }), 'operator:1'),
        customers.create(input({ name: name.toUpperCase() }), 'operator:2'),
      ])

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
      const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult
      expect((rejected.reason as { code: string }).code).toBe(CustomerErrorCode.NAME_TAKEN)
    })
  })

  test('архив: повтор после обрыва с прежней версией — без изменений; архивного не правят', async () => {
    const created = await customers.create(input(), 'operator:1')
    const archived = await customers.archive(created.id, 1, 'operator:1')
    const retried = await customers.archive(created.id, 1, 'operator:1')

    expect(retried.version).toBe(archived.version)
    expect((await actions(created.id)).filter((action) => action === 'customer.archived')).toHaveLength(1)
    expect(await codeOf(customers.update(created.id, { version: archived.version, name: 'x' }, 'operator:1'))).toBe(
      CustomerErrorCode.ARCHIVED,
    )
  })
})
