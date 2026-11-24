import { describe, expect, test } from 'bun:test'
import { loadConfig } from '../config/config'
import { loggerOptions } from './logger'

const options = loggerOptions(
  loadConfig({ DATABASE_URL: 'postgres://u:p@localhost:5432/db', SECRETS_MASTER_KEY: Buffer.alloc(32).toString('base64') }),
)
const pinoHttp = options.pinoHttp as {
  serializers: { req: (request: unknown) => unknown }
  formatters: { log: (object: Record<string, unknown>) => Record<string, unknown> }
  transport?: unknown
}

describe('loggerOptions', () => {
  test('запрос в логе — без секретных заголовков и без query', () => {
    const logged = JSON.stringify(
      pinoHttp.serializers.req({
        id: 1,
        method: 'POST',
        url: '/webhooks/dokploy?token=QUERYSECRET',
        headers: {
          'x-botyard-signature': 'SIGSECRET',
          authorization: 'Bearer AUTHSECRET',
          'x-api-key': 'KEYSECRET',
          'idempotency-key': 'k-1',
        },
      }),
    )

    expect(logged).not.toMatch(/QUERYSECRET|SIGSECRET|AUTHSECRET|KEYSECRET/)
    expect(logged).toContain('/webhooks/dokploy')
    expect(logged).toContain('k-1')
  })

  test('секрет в объекте лога маскируется на любой глубине', () => {
    const logged = JSON.stringify(pinoHttp.formatters.log({ destination: { credentials: { apiKey: 'DEEPSECRET' } } }))

    expect(logged).not.toContain('DEEPSECRET')
  })

  test('без явного флага логи — JSON, а не pino-pretty', () => {
    expect(pinoHttp.transport).toBeUndefined()
  })
})
