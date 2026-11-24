import { describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { CustomerUseCases } from '../../src/modules/customers/application/customer-use-cases'
import { CustomerErrorCode } from '../../src/modules/customers/domain/customer'
import { PostgresCustomerRepository } from '../../src/modules/customers/infrastructure/postgres-customer.repository'
import { AuditLog } from '../../src/shared/audit/audit'
import { LocalKeyEncryptionKey } from '../../src/shared/crypto/key-encryption-key'
import { SecretBox, secretContext } from '../../src/shared/crypto/secret-box'
import { UnitOfWork } from '../../src/shared/database/unit-of-work'
import { db } from './setup'

const unitOfWork = new UnitOfWork(db)
const box = new SecretBox([new LocalKeyEncryptionKey(1, randomBytes(32))])
const customers = new CustomerUseCases(new PostgresCustomerRepository(unitOfWork), box, unitOfWork, new AuditLog(unitOfWork))

const SANDBOX_TOKEN = 't.sandbox-token-0123456789abcdef'
const LIVE_TOKEN = 't.live-token-0123456789abcdefghij'

const input = (overrides: Record<string, unknown> = {}) => ({
  name: `client-${crypto.randomUUID().slice(0, 8)}`,
  accountId: '2000123456',
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

  test('боевой режим — только с точным именем и новым токеном; токен песочницы как боевой не открывается', async () => {
    const created = await customers.create(input(), 'operator:1')

    expect(await codeOf(customers.goLive(created.id, { version: 1, token: LIVE_TOKEN, confirmName: 'wrong' }, 'operator:1'))).toBe(
      CustomerErrorCode.LIVE_CONFIRMATION_REQUIRED,
    )
    await expect(box.open(created.tokenSealed, secretContext('customer', created.id, 'tinvest_token', 'live'))).rejects.toThrow()

    const live = await customers.goLive(created.id, { version: 1, token: LIVE_TOKEN, confirmName: created.name }, 'operator:1')
    expect(live.sandbox).toBe(false)
    expect(await customers.revealToken(live)).toBe(LIVE_TOKEN)

    const audit = await db.selectFrom('audit_event').select('action').where('target_id', '=', created.id).execute()
    expect(audit.map((row) => row.action)).toContain('customer.live_enabled')
  })

  test('переключение режима в базе в обход сценария не делает токен песочницы боевым', async () => {
    const created = await customers.create(input(), 'operator:1')
    await db.updateTable('customer').set({ sandbox: false }).where('id', '=', created.id).execute()
    const tampered = await customers.get(created.id)

    await expect(customers.revealToken(tampered)).rejects.toThrow()
  })

  test('гонка двух правок по одной версии — проходит одна', async () => {
    const created = await customers.create(input(), 'operator:1')
    const results = await Promise.allSettled([
      customers.update(created.id, { version: 1, accountId: '111' }, 'operator:1'),
      customers.rotateToken(created.id, { version: 1, token: 't.other-sandbox-token-0123456789' }, 'operator:2'),
    ])

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(((results.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason as { code: string }).code).toBe(
      CustomerErrorCode.VERSION_CONFLICT,
    )
  })

  test('гонка: правка во время перевода в боевой режим — переход не проходит по устаревшей версии', async () => {
    const created = await customers.create(input(), 'operator:1')
    await customers.update(created.id, { version: 1, accountId: '222' }, 'operator:2')

    expect(await codeOf(customers.goLive(created.id, { version: 1, token: LIVE_TOKEN, confirmName: created.name }, 'operator:1'))).toBe(
      CustomerErrorCode.VERSION_CONFLICT,
    )
  })

  test('имя уникально без учёта регистра', async () => {
    const created = await customers.create(input(), 'operator:1')

    expect(await codeOf(customers.create(input({ name: created.name.toUpperCase() }), 'operator:1'))).toBe(CustomerErrorCode.NAME_TAKEN)
  })

  test('архив: повтор без изменений; архивного клиента не правят', async () => {
    const created = await customers.create(input(), 'operator:1')
    const archived = await customers.archive(created.id, 1, 'operator:1')
    const again = await customers.archive(created.id, archived.version, 'operator:1')

    expect(again.version).toBe(archived.version)
    expect(await codeOf(customers.update(created.id, { version: archived.version, name: 'x' }, 'operator:1'))).toBe(
      CustomerErrorCode.ARCHIVED,
    )
  })
})
