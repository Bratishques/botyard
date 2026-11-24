import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Logger } from 'nestjs-pino'
import { AppModule } from './app.module'
import { OperationWorker } from './modules/deployments/application/operation-worker'
import { OperationStepConsumer } from './modules/deployments/presentation/operation-step.consumer'
import { type AppConfig, loadConfig, ProcessRole } from './shared/config/config'
import { createDb } from './shared/database/database'
import { HttpExceptionFilter } from './shared/http/http-exception.filter'
import { connectBroker } from './shared/messaging/rabbitmq'
import { createProcessLogger } from './shared/observability/logger'
import { registry } from './shared/observability/metrics'
import { CONFIRM_TIMEOUT_MS, OutboxRelay } from './shared/outbox/relay'

/**
 * Один образ — несколько процессов. Роль выбирается окружением, чтобы http, воркер саги, relay
 * outbox и reconciler масштабировались и падали независимо друг от друга.
 */
async function main(): Promise<void> {
  const config = loadConfig()

  switch (config.PROCESS_ROLE) {
    case ProcessRole.HTTP:
      return startHttp(config)
    case ProcessRole.RELAY:
      return startRelay(config)
    case ProcessRole.WORKER:
      return startWorker(config)
    default:
      throw new Error(`process role ${config.PROCESS_ROLE} is not implemented yet`)
  }
}

export async function createHttpApp(config: AppConfig): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(config), { bufferLogs: true })
  app.useLogger(app.get(Logger))
  app.disable('x-powered-by')
  // IP клиента для лимита входов: за Traefik без этого у всех один адрес (см. TRUST_PROXY в config.ts)
  app.set('trust proxy', config.TRUST_PROXY)
  app.useGlobalFilters(new HttpExceptionFilter())
  app.enableShutdownHooks()

  return app
}

async function startHttp(config: AppConfig): Promise<void> {
  const app = await createHttpApp(config)
  await app.listen(config.PORT)
}

/**
 * Relay outbox → RabbitMQ: отдельный процесс, масштабируется и падает независимо от http. Потеря брокера —
 * выход с кодом 1: процесс, который крутится с мёртвым каналом, оркестратор считает здоровым.
 */
async function startRelay(config: AppConfig): Promise<void> {
  if (!config.RABBITMQ_URL) throw new Error('RABBITMQ_URL is required for PROCESS_ROLE=relay')
  const logger = createProcessLogger(config, 'outbox-relay')
  // Транзакция relay держится на подтверждении брокера: зависнет — Postgres закроет её сам
  const db = createDb(config.DATABASE_URL, { max: 2, idleInTransactionTimeoutMs: CONFIRM_TIMEOUT_MS * 3 })
  const broker = await connectBroker(config.RABBITMQ_URL)
  const relay = new OutboxRelay(db, broker, logger)
  const metrics = Bun.serve({
    hostname: config.METRICS_HOST,
    port: config.METRICS_PORT,
    fetch: async (request) =>
      new URL(request.url).pathname === '/metrics'
        ? new Response(await registry.metrics(), { headers: { 'content-type': registry.contentType } })
        : new Response('not found', { status: 404 }),
  })

  const shutdown = () => relay.stop()
  process.once('SIGTERM', shutdown)
  process.once('SIGINT', shutdown)
  try {
    await relay.run()
    logger.info('outbox relay stopped')
  } catch (error) {
    logger.fatal({ err: error }, 'outbox relay lost the broker, exiting')
    process.exitCode = 1
  } finally {
    await broker.close()
    await db.destroy()
    await metrics.stop(true)
  }
}

/**
 * Воркер саги: тот же граф модулей без HTTP, потребитель `botyard.operation.step`. Потеря брокера —
 * выход с кодом 1, как у relay; SIGTERM — перестать брать новые шаги и дождаться начатых.
 */
async function startWorker(config: AppConfig): Promise<void> {
  if (!config.RABBITMQ_URL) throw new Error('RABBITMQ_URL is required for PROCESS_ROLE=worker')
  const logger = createProcessLogger(config, 'saga-worker')
  const app = await NestFactory.createApplicationContext(AppModule.forRoot(config), { bufferLogs: true })
  app.useLogger(app.get(Logger))
  const broker = await connectBroker(config.RABBITMQ_URL)
  const consumer = new OperationStepConsumer(broker, app.get(OperationWorker), logger)

  let stopping: () => void = () => {}
  const stopped = new Promise<void>((resolve) => (stopping = resolve))
  process.once('SIGTERM', () => stopping())
  process.once('SIGINT', () => stopping())

  await consumer.start()
  const lost = await Promise.race([stopped.then(() => null), broker.lost])
  if (lost) {
    logger.fatal({ err: lost }, 'saga worker lost the broker, exiting')
    process.exitCode = 1
  } else {
    await consumer.stop()
    logger.info('saga worker stopped')
  }
  await broker.close()
  await app.close()
}

if (import.meta.main) await main()
