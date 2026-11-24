import { describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { DestinationWebhooks } from '../../src/modules/destinations/application/destination-webhooks'
import { PostgresDestinationWebhookRepository } from '../../src/modules/destinations/infrastructure/postgres-destination-webhook.repository'
import { loadConfig } from '../../src/shared/config/config'
import { LocalKeyEncryptionKey } from '../../src/shared/crypto/key-encryption-key'
import { SecretBox } from '../../src/shared/crypto/secret-box'
import { UnitOfWork } from '../../src/shared/database/unit-of-work'
import { FakeDokployNotifications } from './fakes'
import { db } from './setup'

const unitOfWork = new UnitOfWork(db)
const box = new SecretBox([new LocalKeyEncryptionKey(1, randomBytes(32))])
const publicConfig = loadConfig({ ...process.env, PUBLIC_API_URL: 'https://botyard.example.com/' })

async function destination(): Promise<{ id: string; baseUrl: string }> {
  const id = Bun.randomUUIDv7()
  const baseUrl = `https://dokploy-${id.slice(-8)}.example.com`
  await db
    .insertInto('destination')
    .values({
      id,
      name: `wh-${id.slice(-8)}`,
      base_url: baseUrl,
      api_key_sealed: new Uint8Array([1]),
      api_key_hint: '••••abcd',
      project_id: 'prj',
      environment_id: `env-${id.slice(-12)}`,
      server_id: null,
    })
    .execute()
  return { id, baseUrl }
}

describe('вебхук назначения', () => {
  test('регистрация: адрес из PUBLIC_API_URL, секрет в заголовке; повтор — тот же секрет; сверка за постоянное время', async () => {
    const notifications = new FakeDokployNotifications()
    const webhooks = new DestinationWebhooks(new PostgresDestinationWebhookRepository(unitOfWork), notifications, publicConfig, box)
    const target = await destination()

    await webhooks.register(target, 'api-key')
    const first = notifications.registered.get(`botyard-${target.id}`)
    expect(first?.endpoint).toBe(`https://botyard.example.com/webhooks/dokploy/${target.id}`)
    const token = first?.headers['x-botyard-token'] ?? ''
    expect(token.length).toBeGreaterThanOrEqual(40)

    await webhooks.register(target, 'api-key')
    expect(notifications.registered.get(`botyard-${target.id}`)?.headers['x-botyard-token']).toBe(token)

    expect(await webhooks.verify(target.id, token)).toBe(true)
    expect(await webhooks.verify(target.id, `${token}x`)).toBe(false)
    expect(await webhooks.verify(target.id, undefined)).toBe(false)
    expect(await webhooks.verify(Bun.randomUUIDv7(), token)).toBe(false)
    const row = await db.selectFrom('destination_webhook').selectAll().where('destination_id', '=', target.id).executeTakeFirstOrThrow()
    expect(Buffer.from(row.secret_sealed).includes(Buffer.from(token))).toBe(false)
    expect(row.notification_id).not.toBeNull()
  })

  test('назначение переехало, пока шла регистрация, — её итог отброшен: уведомление старого Dokploy не выдаётся за действующее', async () => {
    const notifications = new FakeDokployNotifications()
    const target = await destination()
    notifications.during = async () => {
      await db
        .updateTable('destination')
        .set({ base_url: `${target.baseUrl}.moved` })
        .where('id', '=', target.id)
        .execute()
    }

    await new DestinationWebhooks(new PostgresDestinationWebhookRepository(unitOfWork), notifications, publicConfig, box).register(
      target,
      'k',
    )

    const row = await db
      .selectFrom('destination_webhook')
      .select('notification_id')
      .where('destination_id', '=', target.id)
      .executeTakeFirstOrThrow()
    expect(row.notification_id).toBeNull()
  })

  test('Dokploy не принял регистрацию — ошибка записана, сценарий не падает; без PUBLIC_API_URL — регистрации нет', async () => {
    const failing = new FakeDokployNotifications()
    failing.fail = true
    const target = await destination()
    await new DestinationWebhooks(new PostgresDestinationWebhookRepository(unitOfWork), failing, publicConfig, box).register(target, 'k')
    const row = await db
      .selectFrom('destination_webhook')
      .select(['error', 'notification_id'])
      .where('destination_id', '=', target.id)
      .executeTakeFirstOrThrow()
    expect(row).toEqual({ error: 'dokploy notification.createCustom: 503', notification_id: null })

    const offline = new FakeDokployNotifications()
    const quiet = await destination()
    const noPublic = loadConfig({ ...process.env, PUBLIC_API_URL: undefined })
    await new DestinationWebhooks(new PostgresDestinationWebhookRepository(unitOfWork), offline, noPublic, box).register(quiet, 'k')
    expect(offline.registered.size).toBe(0)
  })
})
