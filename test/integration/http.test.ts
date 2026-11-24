import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { createHttpApp } from '../../src/main'
import { loadConfig } from '../../src/shared/config/config'
import { MetricsServer } from '../../src/shared/observability/metrics'

let app: NestExpressApplication
let base: string
let metrics: string

/** Свободный порт: занять нулевой, запомнить выданный и отпустить */
function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() })
  const { port } = probe
  probe.stop(true)

  return port ?? 0
}

beforeAll(async () => {
  const metricsPort = freePort()
  app = await createHttpApp(
    loadConfig({ ...process.env, PORT: String(metricsPort + 1), METRICS_PORT: String(metricsPort), METRICS_HOST: '127.0.0.1' }),
  )
  await app.listen(0, '127.0.0.1')

  const address = app.getHttpServer().address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  metrics = `http://127.0.0.1:${app.get(MetricsServer).port}/metrics`
})

afterAll(async () => {
  await app.close()
})

describe('http', () => {
  test('live и ready отвечают, ready проверяет Postgres', async () => {
    const live = await fetch(`${base}/health/live`)
    const ready = await fetch(`${base}/health/ready`)

    expect(live.status).toBe(200)
    expect(await ready.json()).toEqual({ status: 'ok', checks: { postgres: 'ok' } })
  })

  test('не раскрывает фреймворк', async () => {
    const response = await fetch(`${base}/health/live`)

    expect(response.headers.get('x-powered-by')).toBeNull()
  })

  test('метрики только на своём порту, маршрут — шаблоном, несовпавшие — одной серией', async () => {
    await fetch(`${base}/`)
    await fetch(`${base}/destinations/123?token=x`)

    expect((await fetch(`${base}/metrics`)).status).toBe(404)
    const text = await (await fetch(metrics)).text()
    expect(text).toContain('botyard_http_request_duration_seconds_count{method="GET",route="/health/live",status="200"}')
    expect(text).toMatch(/botyard_http_request_duration_seconds_count\{method="GET",route="unmatched",status="404"\} [2-9]/)
    expect(text).not.toContain('/destinations/123')
  })

  test('закрытие приложения закрывает и порт метрик', async () => {
    const port = app.get(MetricsServer).port
    const other = await createHttpApp(
      loadConfig({ ...process.env, PORT: '1', METRICS_PORT: String(freePort()), METRICS_HOST: '127.0.0.1' }),
    )
    const otherPort = other.get(MetricsServer).port
    await other.close()

    expect(port).toBeGreaterThan(0)
    await expect(fetch(`http://127.0.0.1:${otherPort}/metrics`)).rejects.toThrow()
  })
})
