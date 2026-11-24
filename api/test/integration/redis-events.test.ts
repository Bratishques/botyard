import { afterAll, describe, expect, test } from 'bun:test'
import { RedisClient } from 'bun'
import { RedisDeploymentEvents } from '../../src/shared/realtime/deployment-events'

/**
 * Шина живого статуса через настоящий Redis: между процессами и после обрыва подписки. Нужен `REDIS_TEST_URL`
 * (в CI — сервис redis, локально — infra/docker-compose.dev.yml); без него тест пропускается.
 */
const url = process.env.REDIS_TEST_URL
const buses: RedisDeploymentEvents[] = []
afterAll(() => {
  for (const bus of buses) bus.onModuleDestroy()
})

function bus(): RedisDeploymentEvents {
  if (!url) throw new Error('REDIS_TEST_URL is not set')
  const created = new RedisDeploymentEvents(url)
  buses.push(created)
  return created
}

async function until(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await Bun.sleep(20)
  }
}

describe.skipIf(!url)('шина событий через Redis', () => {
  test('событие одного процесса доходит до слушателя другого; обрыв подписки — переподписка и resync', async () => {
    const listener = bus()
    const publisher = bus()
    const received: string[] = []
    let resyncs = 0
    listener.subscribe(
      (id) => received.push(id),
      () => resyncs++,
    )

    // Подписка асинхронна: публиковать, пока не дойдёт
    const first = crypto.randomUUID()
    await until(() => {
      publisher.changed(first)
      return received.includes(first)
    })
    expect(resyncs).toBe(0)

    // Redis рвёт соединения подписчиков (перезапуск, failover): шина переподписывается сама
    const admin = new RedisClient(url)
    await admin.send('CLIENT', ['KILL', 'TYPE', 'pubsub'])
    admin.close()
    await until(() => resyncs === 1)

    const second = crypto.randomUUID()
    await until(() => {
      publisher.changed(second)
      return received.includes(second)
    })
  })
})
