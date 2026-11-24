import { describe, expect, test } from 'bun:test'
import { isSecretKey, pathOnly, REDACTED, redactDeep } from './redact'

describe('redactDeep', () => {
  test('маскирует секрет на любой глубине и в любом стиле имени', () => {
    const logged = redactDeep({
      apiKey: 'k0',
      req: { body: { apiKey: 'k1' }, headers: { 'x-api-key': 'k2', 'x-botyard-signature': 's1', authorization: 'Bearer t' } },
      destination: { credentials: { token: 't1', api_key: 'k3', tinvestToken: 't2', tinvest_token: 't3' } },
      list: [{ password: 'p1' }],
    })

    expect(JSON.stringify(logged)).not.toMatch(/k0|k1|k2|k3|s1|Bearer t|t1|t2|t3|p1/)
    expect(logged).toMatchObject({ apiKey: REDACTED, destination: { credentials: { tinvest_token: REDACTED } } })
  })

  test('не трогает обычные поля и ключ идемпотентности', () => {
    const logged = redactDeep({ name: 'prod', status: 'ACTIVE', 'idempotency-key': 'abc', tokenCount: 3, keyboard: 'x' })

    expect(logged).toEqual({ name: 'prod', status: 'ACTIVE', 'idempotency-key': 'abc', tokenCount: 3, keyboard: 'x' })
  })

  test('раскладывает ошибку и маскирует её поля', () => {
    const error = Object.assign(new Error('dokploy refused'), { request: { headers: { 'x-api-key': 'leak' } } })
    const logged = redactDeep({ err: error }) as { err: Record<string, unknown> }

    expect(logged.err.message).toBe('dokploy refused')
    expect(JSON.stringify(logged)).not.toContain('leak')
  })

  test('переживает цикл и глубину', () => {
    const cyclic: Record<string, unknown> = { name: 'a' }
    cyclic.self = cyclic

    expect(redactDeep(cyclic)).toEqual({ name: 'a', self: '[circular]' })
  })
})

describe('isSecretKey', () => {
  test.each(['apiKey', 'api_key', 'x-api-key', 'token', 'tinvestToken', 'password', 'x-botyard-signature', 'SECRETS_MASTER_KEY', 'cookie'])(
    '%s — секрет',
    (key) => expect(isSecretKey(key)).toBe(true),
  )

  test.each(['name', 'tokenCount', 'idempotency-key', 'keyboard', 'apiKeyHint', 'status'])('%s — не секрет', (key) =>
    expect(isSecretKey(key)).toBe(false),
  )
})

describe('pathOnly', () => {
  test('отрезает query', () => {
    expect(pathOnly('/destinations?token=abc')).toBe('/destinations?[redacted]')
    expect(pathOnly('/health/live')).toBe('/health/live')
  })
})
