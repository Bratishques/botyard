import { Logger } from '@nestjs/common'
import { Counter } from 'prom-client'
import type { Db } from '../database/database'
import type { Broker } from '../messaging/rabbitmq'
import { EXCHANGE } from '../messaging/rabbitmq'
import { registry } from '../observability/metrics'

const relayed = new Counter({
  name: 'botyard_outbox_relayed_total',
  help: 'Сообщения outbox, опубликованные в RabbitMQ',
  registers: [registry],
})

const BATCH = 50
const IDLE_MS = 500

/**
 * Relay outbox → RabbitMQ (`PROCESS_ROLE=relay`). Доставка «хотя бы один раз»:
 *
 *   транзакция { взять порцию неопубликованного FOR UPDATE SKIP LOCKED → опубликовать с подтверждением
 *                брокера → отметить published_at }
 *
 * - SKIP LOCKED: несколько relay не публикуют одно сообщение одновременно и не ждут друг друга;
 * - брокер недоступен — транзакция откатывается, сообщения останутся неопубликованными до следующего раза;
 * - брокер подтвердил, а коммит не прошёл (обрыв базы) — сообщение уйдёт повторно; получатель отсеивает
 *   повтор по `messageId` (= id сообщения outbox).
 */
export class OutboxRelay {
  private readonly logger = new Logger(OutboxRelay.name)
  private stopping = false

  constructor(
    private readonly db: Db,
    private readonly broker: Broker,
  ) {}

  /** Одна порция; число опубликованных сообщений */
  async tick(): Promise<number> {
    return this.db.transaction().execute(async (trx) => {
      const batch = await trx
        .selectFrom('outbox_message')
        .select(['id', 'topic', 'payload'])
        .where('published_at', 'is', null)
        .orderBy('id')
        .limit(BATCH)
        .forUpdate()
        .skipLocked()
        .execute()
      if (batch.length === 0) return 0

      for (const message of batch) {
        this.broker.channel.publish(EXCHANGE, message.topic, Buffer.from(JSON.stringify(message.payload)), {
          persistent: true,
          messageId: message.id,
          contentType: 'application/json',
          type: message.topic,
        })
      }
      await this.broker.channel.waitForConfirms()

      await trx
        .updateTable('outbox_message')
        .set({ published_at: new Date() })
        .where(
          'id',
          'in',
          batch.map((message) => message.id),
        )
        .execute()
      relayed.inc(batch.length)

      return batch.length
    })
  }

  /** Цикл до `stop()`: пустая порция — пауза, ошибка — лог и пауза, без выхода из цикла */
  async run(): Promise<void> {
    while (!this.stopping) {
      try {
        if ((await this.tick()) === 0) await Bun.sleep(IDLE_MS)
      } catch (error) {
        this.logger.error({ err: error }, 'outbox relay tick failed')
        await Bun.sleep(IDLE_MS * 4)
      }
    }
  }

  stop(): void {
    this.stopping = true
  }
}
