import { sql } from 'kysely'
import type { Logger } from 'pino'
import { Counter } from 'prom-client'
import type { Db } from '../database/database'
import { type Broker, EXCHANGE } from '../messaging/rabbitmq'
import { registry } from '../observability/metrics'

const relayed = new Counter({
  name: 'botyard_outbox_relayed_total',
  help: 'Сообщения outbox, опубликованные в RabbitMQ',
  registers: [registry],
})

const BATCH = 50
const IDLE_MS = 500
/** Сколько ждать подтверждения брокера, пока строки порции заблокированы транзакцией */
export const CONFIRM_TIMEOUT_MS = 10_000

export class ReturnedMessagesError extends Error {
  override readonly name = 'ReturnedMessagesError'
}

/**
 * Relay outbox → RabbitMQ (`PROCESS_ROLE=relay`). Доставка «хотя бы один раз»:
 *
 *   транзакция { взять порцию неопубликованного FOR UPDATE SKIP LOCKED → опубликовать с подтверждением
 *                брокера → отметить published_at }
 *
 * - SKIP LOCKED: несколько relay не публикуют одно сообщение одновременно и не ждут друг друга;
 * - публикация `mandatory`: сообщение, которому нет очереди, брокер возвращает, и порция откатывается;
 * - подтверждение ждём не дольше CONFIRM_TIMEOUT_MS, иначе откат: транзакция не висит на сетевом вызове;
 * - брокер подтвердил, а коммит не прошёл (обрыв базы) — сообщение уйдёт повторно с тем же `messageId`
 *   (= id сообщения outbox). Получатель обязан это переживать: воркер саги проверяет шаг операции
 *   по базе и повтор уже сделанного шага ничего не меняет (этап 2, шаг 3);
 * - соединение с брокером потеряно — `run()` завершается с `BrokerLostError`, процесс выходит с ошибкой,
 *   оркестратор его перезапускает. Своего переподключения нет: меньше состояний, которые надо проверять.
 */
export class OutboxRelay {
  private stopping = false
  private lostError: Error | null = null
  /**
   * Ожидания, которые потеря брокера должна прервать. Не `Promise.race` с `broker.lost`: каждая гонка вешала
   * бы на вечно ожидающий промис новую реакцию, и память росла бы с каждым тиком
   */
  private readonly waiters = new Set<(error: Error) => void>()

  constructor(
    private readonly db: Db,
    private readonly broker: Broker,
    private readonly logger?: Pick<Logger, 'error'>,
  ) {
    void broker.lost.then((error) => {
      this.lostError = error
      for (const abort of this.waiters) abort(error)
    })
  }

  /** Одна порция; число опубликованных сообщений */
  async tick(): Promise<number> {
    return this.db.transaction().execute(async (trx) => {
      const batch = await trx
        .selectFrom('outbox_message')
        .select(['id', 'topic', 'payload'])
        .where('published_at', 'is', null)
        .where('available_at', '<=', sql<Date>`now()`)
        .orderBy('id')
        .limit(BATCH)
        .forUpdate()
        .skipLocked()
        .execute()
      if (batch.length === 0) return 0

      const returns = this.broker.trackReturns(new Set(batch.map((message) => message.id)))
      try {
        for (const message of batch) {
          this.broker.channel.publish(EXCHANGE, message.topic, Buffer.from(JSON.stringify(message.payload)), {
            persistent: true,
            mandatory: true,
            messageId: message.id,
            contentType: 'application/json',
            type: message.topic,
          })
        }
        await this.confirmed()
      } finally {
        returns.stop()
      }
      // basic.return приходит раньше basic.ack, поэтому после подтверждения список возвратов полон
      if (returns.returned.size > 0) {
        throw new ReturnedMessagesError(
          `broker returned ${returns.returned.size} unroutable message(s): ${[...returns.returned].join(', ')}`,
        )
      }

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

  /**
   * Цикл до `stop()`: пустая порция — пауза, ошибка — лог и пауза. Потеря брокера — выход с ошибкой:
   * дальше крутиться бессмысленно, канал уже не оживёт.
   */
  async run(): Promise<void> {
    while (!this.stopping) {
      if (this.lostError) throw this.lostError
      try {
        if ((await this.tick()) === 0) await this.pause(IDLE_MS)
      } catch (error) {
        if (this.lostError) throw this.lostError
        this.logger?.error({ err: error }, 'outbox relay tick failed')
        await this.pause(IDLE_MS * 4)
      }
    }
  }

  stop(): void {
    this.stopping = true
  }

  private async confirmed(): Promise<void> {
    let timer: Timer | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`broker did not confirm within ${CONFIRM_TIMEOUT_MS} ms`)), CONFIRM_TIMEOUT_MS)
    })
    try {
      await this.untilLost(Promise.race([this.broker.channel.waitForConfirms(), timeout]))
    } finally {
      clearTimeout(timer)
    }
  }

  private async pause(ms: number): Promise<void> {
    await this.untilLost(Bun.sleep(ms)).catch(() => undefined)
  }

  /** `work`, прерванная потерей брокера; ожидание снимается с учёта, как только завершилось */
  private untilLost<T>(work: Promise<T>): Promise<T> {
    if (this.lostError) return Promise.reject(this.lostError)

    return new Promise<T>((resolve, reject) => {
      this.waiters.add(reject)
      work.then(resolve, reject).finally(() => this.waiters.delete(reject))
    })
  }
}
