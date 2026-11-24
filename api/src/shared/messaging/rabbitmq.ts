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
  /** Собирает `messageId` сообщений, которые брокер вернул (`mandatory`, ни одной очереди), до `stop()` */
  trackReturns(): { readonly returned: ReadonlySet<string>; stop(): void }
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
  const onClose = (what: string) => (cause?: unknown) => {
    if (!closing) markLost(new BrokerLostError(`rabbitmq ${what} closed`, { cause }))
  }
  // Без слушателя `error` amqplib бросает из emit и не доводит закрытие канала до конца:
  // waitForConfirms тогда не завершается никогда. Сама ошибка придёт в `close`
  connection.on('error', () => undefined)
  connection.on('close', onClose('connection'))

  const channel = await connection.createConfirmChannel()
  channel.on('error', () => undefined)
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
    trackReturns() {
      const returned = new Set<string>()
      const listener = (message: Message) => returned.add(String(message.properties.messageId))
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
