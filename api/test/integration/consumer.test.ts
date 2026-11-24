import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { StepMessage } from '../../src/modules/deployments/application/operation-worker'
import { OperationStepConsumer } from '../../src/modules/deployments/presentation/operation-step.consumer'
import { loadConfig } from '../../src/shared/config/config'
import { type Broker, connectBroker, OPERATION_STEP_QUEUE } from '../../src/shared/messaging/rabbitmq'

/** Потребитель `operation.step` на настоящем RabbitMQ: подтверждение, возврат в очередь, отбрасывание */
const url = loadConfig().RABBITMQ_URL ?? ''
const silent = { warn: () => undefined, error: () => undefined }
let publisher: Broker

beforeAll(async () => {
  publisher = await connectBroker(url)
})

afterAll(async () => {
  await publisher.close()
})

beforeEach(async () => {
  await publisher.channel.purgeQueue(OPERATION_STEP_QUEUE)
})

const message = (): StepMessage => ({
  operationId: crypto.randomUUID(),
  deploymentId: crypto.randomUUID(),
  kind: 'PROVISION',
  step: 'ensure_app',
})

function publish(body: unknown): void {
  publisher.channel.sendToQueue(OPERATION_STEP_QUEUE, Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)))
}

async function until(condition: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await Bun.sleep(20)
  }
}

describe('потребитель operation.step', () => {
  test('подтверждение — после обработки: упавший посреди шага процесс не теряет сообщение', async () => {
    const first = await connectBroker(url)
    let started = false
    const hanging = new OperationStepConsumer(
      first,
      {
        handle: async () => {
          started = true
          await new Promise(() => undefined)
        },
      },
      silent,
    )
    await hanging.start()
    const sent = message()
    publish(sent)
    await until(() => started)

    // Процесс умер, не подтвердив: RabbitMQ отдаёт сообщение другому воркеру
    await first.close()
    const second = await connectBroker(url)
    const received: StepMessage[] = []
    const healthy = new OperationStepConsumer(second, { handle: async (step) => void received.push(step) }, silent)
    await healthy.start()
    await until(() => received.length === 1)
    await healthy.stop()
    await second.close()

    expect(received).toEqual([sent])
  })

  test('сбой обработки — сообщение возвращается в очередь и обрабатывается снова', async () => {
    const broker = await connectBroker(url)
    let calls = 0
    const consumer = new OperationStepConsumer(
      broker,
      {
        handle: async () => {
          calls++
          if (calls === 1) throw new Error('database is down')
        },
      },
      silent,
    )
    await consumer.start()
    publish(message())

    await until(() => calls === 2)
    await consumer.stop()
    await broker.close()
    expect(calls).toBe(2)
  })

  test('сообщение не по схеме подтверждается и отбрасывается, воркер его не видит', async () => {
    const broker = await connectBroker(url)
    const received: StepMessage[] = []
    const consumer = new OperationStepConsumer(broker, { handle: async (step) => void received.push(step) }, silent)
    await consumer.start()
    publish('not json')
    publish({ operationId: 'not-a-uuid', step: 'ensure_app' })
    const valid = message()
    publish(valid)

    await until(() => received.length === 1)
    await consumer.stop()
    const left = await broker.channel.checkQueue(OPERATION_STEP_QUEUE)
    await broker.close()
    expect(received).toEqual([valid])
    expect(left.messageCount).toBe(0)
  })
})
