import { Counter, collectDefaultMetrics, Histogram, Registry } from 'prom-client'

export const registry = new Registry()
collectDefaultMetrics({ register: registry })

export const httpRequestDuration = new Histogram({
  name: 'botyard_http_request_duration_seconds',
  help: 'Длительность HTTP-запросов к api',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
})

export const httpRequestsTotal = new Counter({
  name: 'botyard_http_requests_total',
  help: 'HTTP-запросы к api',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [registry],
})

/**
 * Метрики слушают отдельный порт: основной порт смотрит наружу через прокси, а этот — только
 * во внутреннюю сеть к Prometheus. Так не нужна авторизация на /metrics и нет риска её забыть.
 */
export function serveMetrics(port: number): { stop: () => void } {
  const server = Bun.serve({
    port,
    async fetch(request) {
      if (new URL(request.url).pathname !== '/metrics') return new Response('not found', { status: 404 })

      return new Response(await registry.metrics(), { headers: { 'content-type': registry.contentType } })
    },
  })

  return { stop: () => server.stop() }
}
