import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Logger } from 'nestjs-pino'
import { AppModule } from './app.module'
import { type AppConfig, loadConfig, ProcessRole } from './shared/config/config'
import { HttpExceptionFilter } from './shared/http/http-exception.filter'

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

if (import.meta.main) await main()
