import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import accountsFixture from '../../../test/fixtures/tinvest/accounts.json'
import unauthenticatedFixture from '../../../test/fixtures/tinvest/unauthenticated.json'
import { TINVEST_ROOT_CA_PEM } from './tinvest'
import {
  DEFAULT_TINVEST_CLIENT,
  TInvestClient,
  TInvestRejectedError,
  TInvestUnauthenticatedError,
  TInvestUnavailableError,
} from './tinvest.client'

/** T-Invest на Bun.serve: настоящий HTTP; ответы — записанные с живого API и собранные по контракту */
type Reply = { status: number; body?: unknown; headers?: Record<string, string> }
const replies = new Map<string, Reply[]>()
const seen: { path: string; authorization: string | null; body: unknown }[] = []
let server: ReturnType<typeof Bun.serve>
let client: TInvestClient

const TOKEN = 't.client-test-token-0123456789'

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const path = new URL(request.url).pathname
      seen.push({ path, authorization: request.headers.get('authorization'), body: await request.json() })
      const reply = replies.get(path.split('.').at(-1) ?? '')?.shift() ?? { status: 500, body: { code: 13, message: 'no scripted reply' } }
      return Response.json(reply.body ?? null, { status: reply.status, headers: reply.headers })
    },
  })
  const base = `http://127.0.0.1:${server.port}`
  client = new TInvestClient({
    ...DEFAULT_TINVEST_CLIENT,
    ca: null,
    baseUrls: { live: `${base}/live`, sandbox: `${base}/sandbox` },
    retry: { attempts: 3, baseDelayMs: 1, maxDelayMs: 2 },
  })
})

afterAll(() => {
  server.stop(true)
})

beforeEach(() => {
  replies.clear()
  seen.length = 0
})

async function failure(work: Promise<unknown>): Promise<Error> {
  try {
    await work
  } catch (error) {
    if (error instanceof Error) return error
  }
  throw new Error('expected a failure')
}

describe('клиент T-Invest', () => {
  test('по умолчанию TLS — только с корнем Минцифры (Bun заменяет им системные корни)', async () => {
    let tls: unknown
    const capture = Object.assign(
      async (_input: string | URL | Request, init?: RequestInit & { tls?: unknown }) => {
        tls = init?.tls
        return Response.json({ accounts: [] })
      },
      { preconnect: () => undefined },
    )

    await new TInvestClient({ ...DEFAULT_TINVEST_CLIENT, fetch: capture }).accounts('live', TOKEN)

    expect(tls).toEqual({ ca: TINVEST_ROOT_CA_PEM })
  })

  test('боевые счета — UsersService/GetAccounts на боевом контуре, токен в заголовке; пропущенные поля — UNSPECIFIED', async () => {
    replies.set('UsersService/GetAccounts', [{ status: 200, body: accountsFixture }])

    const accounts = await client.accounts('live', TOKEN)

    expect(seen[0]).toEqual({
      path: '/live/tinkoff.public.invest.api.contract.v1.UsersService/GetAccounts',
      authorization: `Bearer ${TOKEN}`,
      body: {},
    })
    expect(accounts[0]).toEqual({
      id: '2000000001',
      type: 'ACCOUNT_TYPE_TINKOFF',
      status: 'ACCOUNT_STATUS_OPEN',
      accessLevel: 'ACCOUNT_ACCESS_LEVEL_FULL_ACCESS',
    })
    expect(accounts[3]).toEqual({
      id: '2000000004',
      type: 'ACCOUNT_TYPE_UNSPECIFIED',
      status: 'ACCOUNT_STATUS_UNSPECIFIED',
      accessLevel: 'ACCOUNT_ACCESS_LEVEL_UNSPECIFIED',
    })
  })

  test('песочница — SandboxService/GetSandboxAccounts на контуре песочницы; пустой ответ — нет счетов', async () => {
    replies.set('SandboxService/GetSandboxAccounts', [{ status: 200, body: {} }])

    expect(await client.accounts('sandbox', TOKEN)).toEqual([])
    expect(seen[0]?.path).toBe('/sandbox/tinkoff.public.invest.api.contract.v1.SandboxService/GetSandboxAccounts')
  })

  test('401 (40003) — токен отклонён, без повторов; текст без токена', async () => {
    replies.set('UsersService/GetAccounts', [{ status: 401, body: unauthenticatedFixture }])

    const error = await failure(client.accounts('live', TOKEN))

    expect(error).toBeInstanceOf(TInvestUnauthenticatedError)
    expect(error.message).toContain('40003')
    expect(error.message).not.toContain(TOKEN)
    expect(seen).toHaveLength(1)
  })

  test('403 — отказ с кодом T-Invest; 5xx и 429 — повторы, затем недоступность', async () => {
    replies.set('UsersService/GetAccounts', [{ status: 403, body: { code: 7, message: 'Insufficient privileges', description: '40002' } }])
    const rejected = await failure(client.accounts('live', TOKEN))
    expect(rejected).toBeInstanceOf(TInvestRejectedError)
    expect(rejected).toMatchObject({ status: 403, errorCode: '40002' })

    seen.length = 0
    replies.set('UsersService/GetAccounts', [
      { status: 503, body: { code: 14, message: 'unavailable' } },
      { status: 429, body: { code: 8, message: 'Request limit exceeded', description: '80002' } },
      { status: 200, body: accountsFixture },
    ])
    expect(await client.accounts('live', TOKEN)).toHaveLength(4)
    expect(seen).toHaveLength(3)

    replies.set('UsersService/GetAccounts', [{ status: 500 }, { status: 500 }, { status: 500 }])
    expect(await failure(client.accounts('live', TOKEN))).toBeInstanceOf(TInvestUnavailableError)
  })

  test('429 подряд не размыкают цепь контура: лимит — свойство токена, а не отказ T-Invest', async () => {
    const tight = new TInvestClient({
      ...DEFAULT_TINVEST_CLIENT,
      ca: null,
      baseUrls: { live: `http://127.0.0.1:${server.port}/live`, sandbox: `http://127.0.0.1:${server.port}/sandbox` },
      retry: { attempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
      breaker: { failureThreshold: 2, openMs: 60_000 },
    })
    const limited = { status: 429, body: { code: 8, message: 'Request limit exceeded', description: 80002 } }
    replies.set('UsersService/GetAccounts', [limited, limited, limited, { status: 200, body: accountsFixture }])

    for (let i = 0; i < 3; i++) {
      const error = await failure(tight.accounts('live', TOKEN))
      expect(error).toMatchObject({ rateLimited: true })
      // description числом (как в OpenAPI) — код не теряется
      expect(error.message).toContain('(80002)')
    }
    expect(await tight.accounts('live', TOKEN)).toHaveLength(4)
  })

  test('пауза перед повтором после 429 — из x-ratelimit-reset; 408 — повторяется как временная ошибка', async () => {
    let wait: number | undefined
    const retrying = new TInvestClient({
      ...DEFAULT_TINVEST_CLIENT,
      ca: null,
      baseUrls: { live: `http://127.0.0.1:${server.port}/live`, sandbox: `http://127.0.0.1:${server.port}/sandbox` },
      retry: { attempts: 2, baseDelayMs: 1, maxDelayMs: 5_000 },
      random: () => 0,
    })
    replies.set('UsersService/GetAccounts', [
      { status: 429, body: { code: 8, message: 'Request limit exceeded', description: '80002' }, headers: { 'x-ratelimit-reset': '1' } },
      { status: 200, body: accountsFixture },
    ])
    const started = Date.now()
    await retrying.accounts('live', TOKEN)
    wait = Date.now() - started
    expect(wait).toBeGreaterThanOrEqual(950)

    seen.length = 0
    replies.set('UsersService/GetAccounts', [
      { status: 408, body: { code: 4, message: 'timeout' } },
      { status: 200, body: accountsFixture },
    ])
    expect(await retrying.accounts('live', TOKEN)).toHaveLength(4)
    expect(seen).toHaveLength(2)
  })

  test('по умолчанию — две попытки по 8 с: проверку ждёт оператор в запросе', () => {
    expect(DEFAULT_TINVEST_CLIENT.retry.attempts).toBe(2)
    expect(DEFAULT_TINVEST_CLIENT.timeoutMs).toBe(8_000)
  })

  test('неожиданная форма ответа — недоступность, а не пустой список', async () => {
    replies.set('UsersService/GetAccounts', [
      { status: 200, body: { accounts: 'nope' } },
      { status: 200, body: { accounts: 'nope' } },
      { status: 200, body: { accounts: 'nope' } },
    ])

    expect(await failure(client.accounts('live', TOKEN))).toBeInstanceOf(TInvestUnavailableError)
  })
})
