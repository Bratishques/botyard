import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { Logger } from 'nestjs-pino'
import { AppModule } from './app.module'
import { type AppConfig, loadConfig, ProcessRole } from './shared/config/config'
import { serveMetrics } from './shared/observability/metrics'

/**
 * Один образ — несколько процессов. Роль выбирается окружением, чтобы http, воркер саги, relay
 * outbox и reconciler масштабировались и падали независимо друг от друга.
 */
async function main(): Promise<void> {
  const config = loadConfig()

  switch (config.PROCESS_ROLE) {
    case ProcessRole.HTTP:
      return startHttp(config)
    default:
      throw new Error(`process role ${config.PROCESS_ROLE} is not implemented yet`)
  }
}

async function startHttp(config: AppConfig): Promise<void> {
  const app = await NestFactory.create(AppModule.forRoot(config), { bufferLogs: true })
  app.useLogger(app.get(Logger))
  app.enableShutdownHooks()

  const metrics = serveMetrics(config.METRICS_PORT)
  process.once('SIGTERM', () => metrics.stop())

  await app.listen(config.PORT)
}

await main()
