import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common'
import { Counter, collectDefaultMetrics, Histogram, Registry } from 'prom-client'
import { APP_CONFIG, type AppConfig } from '../config/config'

export const registry = new Registry()
collectDefaultMetrics({ register: registry })

/** Число запросов — `_count` этой же гистограммы, отдельный счётчик не нужен */
export const httpRequestDuration = new Histogram({
  name: 'botyard_http_request_duration_seconds',
  help: 'Длительность HTTP-запросов к api',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
})

/**
 * Неудачные входы. Неудачи для несуществующих почт в аудит не пишутся (аноним раздувал бы неудаляемый
 * журнал), поэтому видны только здесь. `reason`: `unknown_email`, `wrong_password`, `throttled`, `busy`.
 */
export const loginFailures = new Counter({
  name: 'botyard_login_failures_total',
  help: 'Неудачные попытки входа в админку',
  labelNames: ['reason'] as const,
  registers: [registry],
})

/**
 * Метрики слушают отдельный порт: основной порт смотрит наружу через прокси, а этот — только
 * во внутреннюю сеть к Prometheus. Авторизации на нём нет, поэтому публиковать его наружу
 * нельзя (см. infra/dokploy/README.md). Живёт в жизненном цикле Nest: закрывается вместе
 * с приложением при любом способе остановки.
 */
@Injectable()
export class MetricsServer implements OnModuleInit, OnApplicationShutdown {
  private server: ReturnType<typeof Bun.serve> | undefined

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  onModuleInit(): void {
    this.server = Bun.serve({
      hostname: this.config.METRICS_HOST,
      port: this.config.METRICS_PORT,
      async fetch(request) {
        if (new URL(request.url).pathname !== '/metrics') return new Response('not found', { status: 404 })

        return new Response(await registry.metrics(), { headers: { 'content-type': registry.contentType } })
      },
    })
  }

  get port(): number | undefined {
    return this.server?.port
  }

  async onApplicationShutdown(): Promise<void> {
    await this.server?.stop(true)
  }
}
