import amqp, { type ChannelModel, type ConfirmChannel } from 'amqplib'

/**
 * Топология RabbitMQ Botyard: тематический обменник и устойчивые очереди. Сообщения сохраняются на диск
 * (`persistent`), публикация — с подтверждением брокера. RabbitMQ 4 не разрешает временные
 * неэксклюзивные очереди, поэтому очереди только устойчивые.
 */
export const EXCHANGE = 'botyard'
export const OPERATION_STEP_QUEUE = 'botyard.operation.step'

const BINDINGS: readonly { queue: string; routingKey: string }[] = [{ queue: OPERATION_STEP_QUEUE, routingKey: 'operation.step' }]

export interface Broker {
  readonly channel: ConfirmChannel
  close(): Promise<void>
}

export async function connectBroker(url: string): Promise<Broker> {
  const connection: ChannelModel = await amqp.connect(url)
  const channel = await connection.createConfirmChannel()
  await channel.assertExchange(EXCHANGE, 'topic', { durable: true })
  for (const { queue, routingKey } of BINDINGS) {
    await channel.assertQueue(queue, { durable: true })
    await channel.bindQueue(queue, EXCHANGE, routingKey)
  }

  return {
    channel,
    close: async () => {
      await channel.close().catch(() => undefined)
      await connection.close().catch(() => undefined)
    },
  }
}
