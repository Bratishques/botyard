import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Logger } from 'nestjs-pino'
import { AppModule } from './app.module'
import { type AppConfig, loadConfig, ProcessRole } from './shared/config/config'
import { createDb } from './shared/database/database'
import { HttpExceptionFilter } from './shared/http/http-exception.filter'
import { connectBroker } from './shared/messaging/rabbitmq'
import { registry } from './shared/observability/metrics'
import { OutboxRelay } from './shared/outbox/relay'

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

/** Relay outbox → RabbitMQ: отдельный процесс, масштабируется и падает независимо от http */
async function startRelay(config: AppConfig): Promise<void> {
  if (!config.RABBITMQ_URL) throw new Error('RABBITMQ_URL is required for PROCESS_ROLE=relay')
  const db = createDb(config.DATABASE_URL, { max: 2 })
  const broker = await connectBroker(config.RABBITMQ_URL)
  const relay = new OutboxRelay(db, broker)
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
  await relay.run()
  await broker.close()
  await db.destroy()
  await metrics.stop(true)
}

if (import.meta.main) await main()
