import { describe, expect, test } from 'bun:test'
import { ApiError, createApiClient } from './client'
import { endpoints } from './endpoints'
import { errorMessage } from './errors'
import { Attempt } from './idempotency'

interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body: string | undefined
}

/** fetch-заглушка: отдаёт ответы по очереди и запоминает запросы */
function fakeFetch(...responses: (Response | Error)[]) {
  const calls: Call[] = []
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? init.body : undefined,
    })
    const next = responses.shift()
    if (!next) throw new Error('unexpected request')
    if (next instanceof Error) throw next
    return next
  }
  return { fetch: fetch as typeof globalThis.fetch, calls }
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

async function caught(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof ApiError) return error
    throw error
  }
  throw new Error('expected ApiError')
}

describe('клиент API', () => {
  test('ошибка — по коду из тела; текст API не попадает ни в ApiError, ни в сообщение оператору', async () => {
    const secretish = 'destination 01a2 was changed, reload and retry'
    const { fetch } = fakeFetch(json(409, { code: 'DESTINATION_VERSION_CONFLICT', message: secretish }))
    const api = createApiClient({ baseUrl: '/api', fetch })
    const error = await caught(api.post('/destinations/x/disable', { version: 1 }))
    expect(error.status).toBe(409)
    expect(error.code).toBe('DESTINATION_VERSION_CONFLICT')
    expect(error.message).not.toContain(secretish)
    expect(errorMessage(error)).toBe(
      'Назначение успели изменить. Данные обновлены — откройте форму заново и проверьте. (DESTINATION_VERSION_CONFLICT)',
    )
  })

  test('сетевой сбой, не-JSON 502 и неизвестный код получают свои тексты', async () => {
    const { fetch } = fakeFetch(
      new TypeError('Failed to fetch'),
      new Response('<html>Bad Gateway</html>', { status: 502 }),
      json(418, { code: 'SOMETHING_NEW', message: 'raw' }),
    )
    const api = createApiClient({ baseUrl: '/api', fetch })
    expect(errorMessage(await caught(api.get('/a')))).toBe('Нет связи с сервером. Проверьте сеть и повторите. (NETWORK_ERROR)')
    expect(errorMessage(await caught(api.get('/b')))).toBe('Сервер недоступен. Повторите позже. (HTTP_5XX)')
    expect(errorMessage(await caught(api.get('/c')))).toBe('Ошибка 418. (SOMETHING_NEW)')
  })

  test('лимит входа: Retry-After попадает в текст', async () => {
    const { fetch } = fakeFetch(json(429, { code: 'LOGIN_THROTTLED', message: 'x' }, { 'retry-after': '30' }))
    const api = endpoints(createApiClient({ baseUrl: '/api', fetch }))
    const error = await caught(api.auth.login({ email: 'a@b.c', password: 'p' }))
    expect(errorMessage(error)).toBe(
      'Слишком много неудачных попыток входа. Подождите и повторите. Повторить можно через 30 с. (LOGIN_THROTTLED)',
    )
  })

  test('401 на обычном запросе ведёт на вход и всё равно отдаёт ошибку; 401 на входе и на /auth/me — нет', async () => {
    let redirects = 0
    const { fetch } = fakeFetch(
      json(401, { code: 'UNAUTHENTICATED', message: 'x' }),
      json(401, { code: 'INVALID_CREDENTIALS', message: 'x' }),
      json(401, { code: 'UNAUTHENTICATED', message: 'x' }),
    )
    const api = endpoints(createApiClient({ baseUrl: '/api', fetch, onUnauthenticated: () => redirects++ }))

    expect((await caught(api.destinations.list())).code).toBe('UNAUTHENTICATED')
    expect(redirects).toBe(1)

    expect((await caught(api.auth.login({ email: 'a@b.c', password: 'bad' }))).code).toBe('INVALID_CREDENTIALS')
    expect(redirects).toBe(1)

    // /auth/me — штатная проверка сессии маршрутом: её 401 разбирает beforeLoad, общий переход не нужен
    expect((await caught(api.auth.me())).status).toBe(401)
    expect(redirects).toBe(1)
  })

  test('изменяющий запрос — JSON с префиксом API; GET без тела и без content-type', async () => {
    const { fetch, calls } = fakeFetch(json(200, []), json(200, { id: 'd' }))
    const api = endpoints(createApiClient({ baseUrl: '/api', fetch }))
    await api.destinations.list()
    await api.destinations.check('d')
    expect(calls[0]).toEqual({ url: '/api/destinations', method: 'GET', headers: { accept: 'application/json' }, body: undefined })
    expect(calls[1]?.url).toBe('/api/destinations/d/check')
    expect(calls[1]?.headers['content-type']).toBe('application/json')
    expect(calls[1]?.body).toBe('{}')
  })

  test('204 выхода — без разбора тела', async () => {
    const { fetch } = fakeFetch(new Response(null, { status: 204 }))
    const api = endpoints(createApiClient({ baseUrl: '/api', fetch }))
    expect(await api.auth.logout()).toBeUndefined()
  })
})

describe('Idempotency-Key на попытку пользователя', () => {
  const accepted = { id: 'dep', status: 'STOPPED', operation: { id: 'op' } }

  test('повтор после обрыва и после ошибки уходит с тем же ключом; после успеха — новый ключ', async () => {
    const { fetch, calls } = fakeFetch(
      new TypeError('network down'),
      json(409, { code: 'DEPLOYMENT_OPERATION_IN_PROGRESS', message: 'x' }),
      json(202, accepted),
      json(202, accepted),
    )
    const api = endpoints(createApiClient({ baseUrl: '/api', fetch }))
    const attempt = new Attempt()
    const stop = () => attempt.run((key) => api.deployments.act('dep', 'stop', { version: 3 }, key))

    await caught(stop())
    await caught(stop())
    await stop()
    const keys = calls.map((call) => call.headers['idempotency-key'])
    expect(keys[0]).toMatch(/^[A-Za-z0-9_-]{8,128}$/)
    expect(keys[1]).toBe(keys[0])
    expect(keys[2]).toBe(keys[0])

    // Попытка завершилась успехом: следующее действие в том же диалоге — уже другая попытка
    await stop()
    expect(calls[3]?.headers['idempotency-key']).not.toBe(keys[0])
  })

  test('разные попытки (два открытия формы) — разные ключи', () => {
    expect(new Attempt().key).not.toBe(new Attempt().key)
  })

  test('ключ не зависит от тела: правка данных после возможного успеха получит 409 от API, а не второе развёртывание', async () => {
    const { fetch, calls } = fakeFetch(new TypeError('network down'), json(409, { code: 'IDEMPOTENCY_CONFLICT', message: 'x' }))
    const api = endpoints(createApiClient({ baseUrl: '/api', fetch }))
    const attempt = new Attempt()
    const body = (figi: string) => ({
      customerId: '01a20f17-dfae-71fc-8c35-a72ef3de239c',
      destinationId: '01a20f17-df9e-71f1-ab81-8243a3ef66f9',
      templateId: 'bita',
      config: { figi: [figi] },
    })
    await caught(attempt.run((key) => api.deployments.create(body('A'), key)))
    const error = await caught(attempt.run((key) => api.deployments.create(body('B'), key)))
    expect(calls[1]?.headers['idempotency-key']).toBe(calls[0]?.headers['idempotency-key'])
    expect(errorMessage(error)).toContain('возможно, прошла')
  })
})
