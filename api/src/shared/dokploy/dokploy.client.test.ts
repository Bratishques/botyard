import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import projectsFixture from '../../../test/fixtures/dokploy/project.all.json'
import serversFixture from '../../../test/fixtures/dokploy/server.all.json'
import { DokployClient, retryAfterMs } from './dokploy.client'
import { DokployRejectedError, DokployResponseError, DokployUnauthorizedError, DokployUnavailableError } from './dokploy.errors'

/**
 * Заглушка Dokploy на Bun.serve: настоящий HTTP, настоящие таймауты и заголовки. Сценарий ответа
 * задаётся очередью на каждый метод; запросы записываются для проверок.
 */
type Reply = { status: number; body?: unknown; headers?: Record<string, string>; delayMs?: number }
const replies = new Map<string, Reply[]>()
const seen: { method: string; url: string; apiKey: string | null }[] = []
let server: ReturnType<typeof Bun.serve>
let baseUrl: string

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const url = new URL(request.url)
      const method = url.pathname.replace('/api/', '')
      seen.push({ method, url: request.url, apiKey: request.headers.get('x-api-key') })
      const reply = replies.get(method)?.shift() ?? { status: 500, body: { message: 'no scripted reply' } }
      if (reply.delayMs) await Bun.sleep(reply.delayMs)

      return Response.json(reply.body ?? null, { status: reply.status, headers: reply.headers })
    },
  })
  baseUrl = `http://127.0.0.1:${server.port}`
})

afterAll(() => {
  server.stop(true)
})

beforeEach(() => {
  replies.clear()
  seen.length = 0
})

const script = (method: string, ...list: Reply[]) => replies.set(method, list)
const client = (overrides: Partial<ConstructorParameters<typeof DokployClient>[0]> = {}) =>
  new DokployClient({
    timeoutMs: 500,
    retry: { attempts: 3, baseDelayMs: 1, maxDelayMs: 20 },
    breaker: { failureThreshold: 3, openMs: 60_000 },
    random: () => 0,
    ...overrides,
  })
const target = () => ({ baseUrl, apiKey: 'KEY-SECRET-1234567890' })

describe('DokployClient', () => {
  test('разбирает project.all по полям, которые нужны Botyard, и отбрасывает остальные', async () => {
    script('project.all', { status: 200, body: projectsFixture })

    const projects = await client().listProjects(target())

    expect(projects).toEqual([
      {
        projectId: 'prj_botyard_1',
        name: 'botyard',
        environments: [
          { environmentId: 'env_prod_1', name: 'production', isDefault: true },
          { environmentId: 'env_stage_1', name: 'staging', isDefault: false },
        ],
      },
    ])
  })

  test('разбирает server.all', async () => {
    script('server.all', { status: 200, body: serversFixture })

    expect(await client().listServers(target())).toEqual([
      { serverId: 'srv_1', name: 'bots-eu-1', ipAddress: '203.0.113.10', serverStatus: 'active', serverType: 'deploy' },
    ])
  })

  test('ключ уходит только заголовком x-api-key, не в URL и не в текст ошибки', async () => {
    script('project.all', { status: 400, body: { message: 'bad input' } })

    const error = await client()
      .listProjects(target())
      .catch((caught: unknown) => caught)

    expect(seen[0]?.apiKey).toBe('KEY-SECRET-1234567890')
    expect(seen[0]?.url).not.toContain('KEY-SECRET')
    expect(String(error)).not.toContain('KEY-SECRET')
  })

  test('401 — неверный ключ, без повторов', async () => {
    script('project.all', { status: 401, body: { message: 'Unauthorized' } })

    await expect(client().listProjects(target())).rejects.toBeInstanceOf(DokployUnauthorizedError)
    expect(seen).toHaveLength(1)
  })

  test('прочие 4xx — отклонённый запрос, без повторов', async () => {
    script('project.all', { status: 404, body: { message: 'Not found' } })

    await expect(client().listProjects(target())).rejects.toBeInstanceOf(DokployRejectedError)
    expect(seen).toHaveLength(1)
  })

  test('5xx повторяется, первый успех возвращается', async () => {
    script('project.all', { status: 502 }, { status: 503 }, { status: 200, body: projectsFixture })

    expect(await client().listProjects(target())).toHaveLength(1)
    expect(seen).toHaveLength(3)
  })

  test('429 ждёт названную паузу, а после всех попыток — недоступность с паузой', async () => {
    script('project.all', ...Array.from({ length: 3 }, () => ({ status: 429, headers: { 'retry-after': '0' } })))

    const error = await client()
      .listProjects(target())
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(DokployUnavailableError)
    expect((error as DokployUnavailableError).retryAfterMs).toBe(0)
    expect(seen).toHaveLength(3)
  })

  test('таймаут — недоступность, запрос отменяется', async () => {
    script('project.all', ...Array.from({ length: 3 }, () => ({ status: 200, body: projectsFixture, delayMs: 300 })))

    const started = performance.now()
    const error = await client({ timeoutMs: 50 })
      .listProjects(target())
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(DokployUnavailableError)
    expect(String((error as Error).message)).toContain('no answer in 50 ms')
    expect(performance.now() - started).toBeLessThan(600)
  })

  test('непонятный ответ — явная ошибка формы, а не тихий пустой список', async () => {
    script('project.all', { status: 200, body: { result: { data: [] } } })

    await expect(client({ retry: { attempts: 1, baseDelayMs: 1, maxDelayMs: 1 } }).listProjects(target())).rejects.toBeInstanceOf(
      DokployResponseError,
    )
  })

  test('цепь размыкается для упавшего адреса и не трогает другие назначения', async () => {
    const shared = client({ retry: { attempts: 1, baseDelayMs: 1, maxDelayMs: 1 } })
    script('project.all', { status: 503 }, { status: 503 }, { status: 503 })
    for (let i = 0; i < 3; i++) await shared.listProjects(target()).catch(() => undefined)
    seen.length = 0

    const open = await shared.listProjects(target()).catch((caught: unknown) => caught)
    expect(open).toBeInstanceOf(DokployUnavailableError)
    expect(String((open as Error).message)).toContain('circuit open')
    expect(seen).toHaveLength(0)

    script('project.all', { status: 200, body: projectsFixture })
    const otherAddress = { baseUrl: `http://localhost:${server.port}`, apiKey: 'other' }
    expect(await shared.listProjects(otherAddress)).toHaveLength(1)
  })

  test('неверный ключ цепь не размыкает', async () => {
    const shared = client({ breaker: { failureThreshold: 1, openMs: 60_000 } })
    script('project.all', { status: 401 }, { status: 200, body: projectsFixture })

    await expect(shared.listProjects(target())).rejects.toBeInstanceOf(DokployUnauthorizedError)
    expect(await shared.listProjects(target())).toHaveLength(1)
  })
})

describe('retryAfterMs', () => {
  test('секунды и HTTP-дата', () => {
    expect(retryAfterMs('3')).toBe(3_000)
    expect(retryAfterMs('Tue, 24 Nov 2026 12:00:10 GMT', Date.parse('Tue, 24 Nov 2026 12:00:00 GMT'))).toBe(10_000)
    expect(retryAfterMs('soon')).toBeUndefined()
    expect(retryAfterMs(null)).toBeUndefined()
  })
})
