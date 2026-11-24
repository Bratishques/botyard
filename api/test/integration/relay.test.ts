import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { sql } from 'kysely'
import { loadConfig } from '../../src/shared/config/config'
import { UnitOfWork } from '../../src/shared/database/unit-of-work'
import { type Broker, BrokerLostError, connectBroker, OPERATION_STEP_QUEUE } from '../../src/shared/messaging/rabbitmq'
import { Outbox, OutboxTopic } from '../../src/shared/outbox/outbox'
import { OutboxRelay, ReturnedMessagesError } from '../../src/shared/outbox/relay'
import { db } from './setup'

/** Relay на настоящих Postgres и RabbitMQ (infra/docker-compose.dev.yml, в CI — сервисы) */
const url = loadConfig().RABBITMQ_URL ?? ''
const unitOfWork = new UnitOfWork(db)
const outbox = new Outbox(unitOfWork)
let broker: Broker

beforeAll(async () => {
  broker = await connectBroker(url)
})

afterAll(async () => {
  await broker.close()
})

beforeEach(async () => {
  await sql`DELETE FROM outbox_message`.execute(db)
  await broker.channel.purgeQueue(OPERATION_STEP_QUEUE)
})

async function enqueue(count: number): Promise<string[]> {
  return unitOfWork.run(async () => {
    const ids: string[] = []
    for (let i = 0; i < count; i++)
      ids.push(await outbox.enqueue(OutboxTopic.OPERATION_STEP, { operationId: `op-${i}`, kind: 'PROVISION' }))
    return ids
  })
}

async function drain(): Promise<{ messageId: string; body: unknown }[]> {
  const received: { messageId: string; body: unknown }[] = []
  for (;;) {
    const message = await broker.channel.get(OPERATION_STEP_QUEUE, { noAck: true })
    if (!message) return received
    received.push({ messageId: String(message.properties.messageId), body: JSON.parse(message.content.toString()) })
  }
}

describe('outbox relay', () => {
  test('публикует порцию с messageId = id сообщения outbox и отмечает её; повтор ничего не шлёт', async () => {
    const ids = await enqueue(3)
    const relay = new OutboxRelay(db, broker)

    expect(await relay.tick()).toBe(3)
    expect(await relay.tick()).toBe(0)
    const received = await drain()
    expect(received.map((message) => message.messageId)).toEqual(ids)
    expect(received[0]?.body).toEqual({ operationId: 'op-0', kind: 'PROVISION' })
    const unpublished = await db.selectFrom('outbox_message').select('id').where('published_at', 'is', null).execute()
    expect(unpublished).toHaveLength(0)
  })

  test('два relay одновременно — второй не ждёт первого (SKIP LOCKED), каждое сообщение ровно один раз', async () => {
    const ids = await enqueue(10)
    // Первый relay выбрал порцию и ждёт подтверждения брокера; второй стартует именно в это окно
    let selected: () => void = () => {}
    const firstSelected = new Promise<void>((resolve) => (selected = resolve))
    const slowChannel = Object.create(broker.channel)
    slowChannel.waitForConfirms = async () => {
      selected()
      await Bun.sleep(300)
      return broker.channel.waitForConfirms()
    }
    const slow = new OutboxRelay(db, { ...broker, channel: slowChannel })
    const second = await connectBroker(url)
    const fast = new OutboxRelay(db, second)

    const finished: string[] = []
    const [slowCount, fastCount] = await Promise.all([
      slow.tick().then((count) => (finished.push('slow'), count)),
      firstSelected.then(() => fast.tick()).then((count) => (finished.push('fast'), count)),
    ])
    await second.close()

    // С обычным FOR UPDATE второй ждал бы коммита первого и закончил бы после него
    expect(finished).toEqual(['fast', 'slow'])
    expect(slowCount + fastCount).toBe(ids.length)
    const received = await drain()
    expect(received).toHaveLength(ids.length)
    expect(new Set(received.map((message) => message.messageId)).size).toBe(ids.length)
  })

  test('сообщение без очереди брокер возвращает — порция откатывается и не помечается', async () => {
    await enqueue(1)
    await db.insertInto('outbox_message').values({ id: Bun.randomUUIDv7(), topic: 'nobody.listens', payload: '{}' }).execute()

    await expect(new OutboxRelay(db, broker).tick()).rejects.toBeInstanceOf(ReturnedMessagesError)
    const unpublished = await db.selectFrom('outbox_message').select('id').where('published_at', 'is', null).execute()
    expect(unpublished).toHaveLength(2)
    await sql`DELETE FROM outbox_message`.execute(db)
  })

  test('соединение с брокером оборвалось — run() завершается BrokerLostError, а не крутится вечно', async () => {
    const own = await connectBroker(url)
    const relay = new OutboxRelay(db, own)
    const running = relay.run()
    // Закрытие соединения в обход close() — то же, что видит процесс при перезапуске RabbitMQ
    await (own.channel as unknown as { connection: { close(): Promise<void> } }).connection.close()

    await expect(running).rejects.toBeInstanceOf(BrokerLostError)
    relay.stop()
  })

  test('брокер недоступен — сообщения остаются неопубликованными', async () => {
    await enqueue(2)
    const dead = await connectBroker(url)
    await dead.close()

    await expect(new OutboxRelay(db, dead).tick()).rejects.toThrow()
    const unpublished = await db.selectFrom('outbox_message').select('id').where('published_at', 'is', null).execute()
    expect(unpublished).toHaveLength(2)
  })
})
