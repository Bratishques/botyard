import type { ConsumeMessage } from 'amqplib'
import type { Logger } from 'pino'
import { z } from 'zod'
import { type Broker, OPERATION_STEP_QUEUE } from '../../../shared/messaging/rabbitmq'
import type { OperationWorker } from '../application/operation-worker'

const stepMessage = z.object({
  operationId: z.uuid(),
  deploymentId: z.uuid(),
  kind: z.string(),
  step: z.string(),
  wake: z.string().optional(),
})

/** Сколько сообщений воркер обрабатывает одновременно: шаги ходят в Dokploy и ждут его ответа */
const PREFETCH = 8
/** Пауза перед возвратом сообщения в очередь после сбоя: база недоступна — не крутить его в цикле */
const REQUEUE_DELAY_MS = 2_000

/**
 * Потребитель `botyard.operation.step`. Подтверждение — после обработки: упавший процесс не теряет шаг,
 * RabbitMQ отдаст его другому воркеру (повторная доставка штатна, см. OperationWorker).
 *
 * - сообщение не по схеме — в лог и подтвердить: повтор его не исправит;
 * - сбой обработки (база, неожиданная ошибка) — вернуть в очередь после паузы.
 */
export class OperationStepConsumer {
  private tag: string | undefined
  private readonly inFlight = new Set<Promise<void>>()

  constructor(
    private readonly broker: Broker,
    private readonly worker: OperationWorker,
    private readonly logger: Pick<Logger, 'warn' | 'error'>,
  ) {}

  async start(): Promise<void> {
    await this.broker.channel.prefetch(PREFETCH)
    const { consumerTag } = await this.broker.channel.consume(OPERATION_STEP_QUEUE, (message) => {
      if (!message) return
      const work = this.process(message)
      this.inFlight.add(work)
      void work.finally(() => this.inFlight.delete(work))
    })
    this.tag = consumerTag
  }

  /** Перестать брать новые сообщения и дождаться начатых */
  async stop(): Promise<void> {
    if (this.tag) await this.broker.channel.cancel(this.tag).catch(() => undefined)
    await Promise.allSettled([...this.inFlight])
  }

  private async process(message: ConsumeMessage): Promise<void> {
    const parsed = stepMessage.safeParse(parseJson(message.content))
    if (!parsed.success) {
      this.logger.warn({ messageId: message.properties.messageId }, 'operation.step message does not match the schema, dropped')
      this.broker.channel.ack(message)
      return
    }

    try {
      await this.worker.handle(parsed.data)
      this.broker.channel.ack(message)
    } catch (error) {
      this.logger.error({ err: error, operationId: parsed.data.operationId, step: parsed.data.step }, 'operation step failed, requeued')
      await Bun.sleep(REQUEUE_DELAY_MS)
      this.broker.channel.nack(message, false, true)
    }
  }
}

function parseJson(content: Buffer): unknown {
  try {
    return JSON.parse(content.toString('utf8'))
  } catch {
    return undefined
  }
}
