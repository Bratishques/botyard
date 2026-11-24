import amqp, { type ChannelModel, type ConfirmChannel, type Message } from 'amqplib'
import { OutboxTopic } from '../outbox/outbox'

/**
 * Топология RabbitMQ Botyard: тематический обменник и устойчивые очереди. Сообщения сохраняются на диск
 * (`persistent`), публикация — с подтверждением брокера. RabbitMQ 4 не разрешает временные
 * неэксклюзивные очереди, поэтому очереди только устойчивые.
 */
export const EXCHANGE = 'botyard'
export const OPERATION_STEP_QUEUE = 'botyard.operation.step'

/** Привязка на каждую тему outbox: тема без привязки — ошибка типов, а не тихо выброшенные команды */
const BINDINGS: Record<OutboxTopic, string> = {
  [OutboxTopic.OPERATION_STEP]: OPERATION_STEP_QUEUE,
}

export interface Broker {
  readonly channel: ConfirmChannel
  /**
   * Срабатывает, когда соединение или канал закрылись не через `close()`: перезапуск брокера, ошибка
   * канала, обрыв сети. Переподключения нет: процесс выходит, его перезапускает оркестратор.
   */
  readonly lost: Promise<Error>
  /**
   * Собирает возвращённые брокером (`mandatory`, ни одной очереди) сообщения из `ids` до `stop()`. Фильтр по id:
   * запоздалый возврат прошлой порции не откатит следующую
   */
  trackReturns(ids: ReadonlySet<string>): { readonly returned: ReadonlySet<string>; stop(): void }
  close(): Promise<void>
}

export class BrokerLostError extends Error {
  override readonly name = 'BrokerLostError'
}

export async function connectBroker(url: string): Promise<Broker> {
  const connection: ChannelModel = await amqp.connect(url)
  let closing = false
  let markLost: (error: Error) => void = () => {}
  const lost = new Promise<Error>((resolve) => (markLost = resolve))
  // `close` приходит без причины: её приносит предшествующее `error` (404 NOT_FOUND, 320 CONNECTION_FORCED…).
  // Без слушателя `error` amqplib бросает из emit и не доводит закрытие канала до конца —
  // waitForConfirms тогда не завершается никогда
  let cause: unknown
  const remember = (error: unknown) => {
    cause ??= error
  }
  const onClose = (what: string) => (error?: unknown) => {
    if (!closing) markLost(new BrokerLostError(`rabbitmq ${what} closed`, { cause: error ?? cause }))
  }
  connection.on('error', remember)
  connection.on('close', onClose('connection'))

  const channel = await connection.createConfirmChannel()
  channel.on('error', remember)
  channel.on('close', onClose('channel'))
  const returnListeners = new Set<(message: Message) => void>()
  channel.on('return', (message: Message) => {
    for (const listener of returnListeners) listener(message)
  })

  await channel.assertExchange(EXCHANGE, 'topic', { durable: true })
  for (const [routingKey, queue] of Object.entries(BINDINGS)) {
    await channel.assertQueue(queue, { durable: true })
    await channel.bindQueue(queue, EXCHANGE, routingKey)
  }

  return {
    channel,
    lost,
    trackReturns(ids) {
      const returned = new Set<string>()
      const listener = (message: Message) => {
        const id = String(message.properties.messageId)
        if (ids.has(id)) returned.add(id)
      }
      returnListeners.add(listener)

      return { returned, stop: () => returnListeners.delete(listener) }
    },
    close: async () => {
      closing = true
      await channel.close().catch(() => undefined)
      await connection.close().catch(() => undefined)
    },
  }
}
