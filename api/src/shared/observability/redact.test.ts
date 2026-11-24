import { describe, expect, test } from 'bun:test'
import { isSecretKey, pathOnly, REDACTED, redactDeep, redactString } from './redact'

describe('redactDeep', () => {
  test('маскирует секрет на любой глубине и в любом стиле имени', () => {
    const logged = redactDeep({
      apiKey: 'k0',
      req: { body: { apiKey: 'k1' }, headers: { 'x-api-key': 'k2', 'x-botyard-signature': 's1', authorization: 'Bearer t' } },
      destination: { credentials: { token: 't1', api_key: 'k3', tinvestToken: 't2', tinvest_token: 't3' } },
      list: [{ password: 'p1' }],
      tokens: ['t4', 't5'],
      DATABASE_URL: 'postgres://u:dbpass@h/db',
      sessionId: 's2',
    })

    expect(JSON.stringify(logged)).not.toMatch(/k0|k1|k2|k3|s1|s2|Bearer t|t1|t2|t3|t4|t5|p1|dbpass/)
    expect(logged).toMatchObject({ apiKey: REDACTED, tokens: REDACTED, destination: { credentials: REDACTED } })
  })

  test('не трогает обычные и служебные поля рядом с секретами', () => {
    const plain = {
      name: 'prod',
      status: 'ACTIVE',
      'idempotency-key': 'abc',
      tokenCount: 3,
      keyboard: 'x',
      apiKeyHint: '••••abcd',
      SECRETS_MASTER_KEY_ID: 1,
      passage: 'p',
    }

    expect(redactDeep(plain)).toEqual(plain)
  })

  test('раскладывает ошибку с причиной и маскирует её поля', () => {
    const cause = Object.assign(new Error('socket hang up'), { config: { headers: { 'x-api-key': 'leak-cause' } } })
    const error = Object.assign(new Error('dokploy refused', { cause }), { request: { headers: { 'x-api-key': 'leak' } } })
    const logged = redactDeep({ err: error }) as { err: { message: string; cause: { message: string } } }

    expect(logged.err.message).toBe('dokploy refused')
    expect(logged.err.cause.message).toBe('socket hang up')
    expect(JSON.stringify(logged)).not.toMatch(/leak/)
  })

  test('общий объект в двух ветках — не цикл, настоящий цикл — помечен', () => {
    const shared = { name: 'a' }
    const cyclic: Record<string, unknown> = { name: 'b' }
    cyclic.self = cyclic

    expect(redactDeep({ left: shared, right: shared })).toEqual({ left: { name: 'a' }, right: { name: 'a' } })
    expect(redactDeep(cyclic)).toEqual({ name: 'b', self: '[circular]' })
  })

  test('экземпляры классов не обходит, Map и Headers раскрывает с маской', () => {
    class Socket {
      secret = 'inside'
    }

    expect(redactDeep({ socket: new Socket() })).toEqual({ socket: '[Socket]' })
    expect(
      redactDeep(
        new Map([
          ['token', 'm1'],
          ['name', 'x'],
        ]),
      ),
    ).toEqual({ token: REDACTED, name: 'x' })
    expect(redactDeep(new Headers({ authorization: 'Bearer h1', accept: 'json' }))).toEqual({ authorization: REDACTED, accept: 'json' })
    expect(redactDeep({ body: Buffer.from('raw-secret') })).toEqual({ body: '[binary 10 bytes]' })
  })
})

describe('redactString', () => {
  test('маскирует секреты по виду значения', () => {
    const text = redactString(
      'call failed: Authorization Bearer abc.def-123 to postgres://user:pw@db:5432/x with t.AbCdEfGhIjKlMnOpQrStUvWx',
    )

    expect(text).not.toMatch(/abc\.def-123|user:pw|AbCdEfGhIjKlMnOpQrStUvWx/)
    expect(text).toContain('postgres://[redacted]@db:5432/x')
  })

  test('регистр схемы и @ в пароле не мешают маске', () => {
    const text = redactString('auth: bearer lowSECRET, Token tokSECRET, url postgres://u:p@ssSECRET@db/x')

    expect(text).not.toMatch(/lowSECRET|tokSECRET|ssSECRET/)
    expect(text).toContain('postgres://[redacted]@db/x')
  })

  test('не трогает обычный текст', () => {
    expect(redactString('deployment t.1 started at https://dokploy.example.com/app')).toBe(
      'deployment t.1 started at https://dokploy.example.com/app',
    )
  })
})

describe('isSecretKey', () => {
  test.each([
    'apiKey',
    'apiKeys',
    'api_key',
    'x-api-key',
    'token',
    'tokens',
    'tinvestToken',
    'password',
    'x-botyard-signature',
    'SECRETS_MASTER_KEY',
    'cookie',
    'credentials',
    'connectionString',
    'DATABASE_URL',
    'sessionId',
    'jwt',
    'tokenValue',
    'apiKeyPlain',
    'privateKeyPem',
    'secretData',
  ])('%s — секрет', (key) => expect(isSecretKey(key)).toBe(true))

  test.each([
    'name',
    'tokenCount',
    'idempotency-key',
    'keyboard',
    'apiKeyHint',
    'status',
    'SECRETS_MASTER_KEY_ID',
    'passage',
    'author',
    'is_secret',
    'max_tokens',
    'hasToken',
  ])('%s — не секрет', (key) => expect(isSecretKey(key)).toBe(false))
})

describe('pathOnly', () => {
  test('отрезает query', () => {
    expect(pathOnly('/destinations?token=abc')).toBe('/destinations?[redacted]')
    expect(pathOnly('/health/live')).toBe('/health/live')
  })
})
