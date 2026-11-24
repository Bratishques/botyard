import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createServer, type Server } from 'node:http'
import { Writable } from 'node:stream'
import pinoHttp, { type Options } from 'pino-http'
import { loadConfig } from '../config/config'
import { loggerOptions } from './logger'

const config = loadConfig({ DATABASE_URL: 'postgres://u:p@localhost:5432/db', SECRETS_MASTER_KEY: Buffer.alloc(32).toString('base64') })
const options = loggerOptions(config).pinoHttp as Options

/**
 * Настоящий pino-http на настоящем HTTP-сервере: порядок форматтера и сериализаторов
 * проверяется только так, вызов функций по отдельности его не покажет.
 */
const lines: Record<string, unknown>[] = []
const sink = new Writable({
  write(chunk, _encoding, done) {
    for (const line of String(chunk).split('\n').filter(Boolean)) lines.push(JSON.parse(line))
    done()
  },
})
const logger = pinoHttp(options, sink)

let server: Server
let base: string

beforeAll(async () => {
  server = createServer((request, response) => {
    logger(request, response)
    if (request.url?.startsWith('/boom')) {
      response.statusCode = 500
      const cause = Object.assign(new Error('socket hang up'), { headers: { 'x-api-key': 'CAUSEKEY' } })
      response.err = Object.assign(new Error('dokploy said no to postgres://user:ERRPASS@db/x', { cause }), {
        config: { apiKey: 'ERRKEY' },
      })
      response.end()
      return
    }
    if (request.url?.startsWith('/webhooks/')) {
      request.log.info({ destination: { credentials: { apiKey: 'DEEPSECRET' } } }, 'calling dokploy')
      request.log.info({ apiKey: 'TOPKEY', password: 'TOPPASS', tokenValue: 'TOPTOKEN' }, 'top level fields')
      request.log.warn('dokploy failed for postgres://u:MSGPASS@db/x with bearer MSGBEARER')
    }
    response.statusCode = request.url?.startsWith('/health/') ? 200 : 202
    response.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

afterAll(() => {
  server.close()
})

async function call(path: string, headers: Record<string, string> = {}): Promise<Record<string, unknown>[]> {
  lines.length = 0
  await fetch(`${base}${path}`, { headers })
  await Bun.sleep(20)

  return [...lines]
}

describe('логи запросов через pino-http', () => {
  test('запись о запросе содержит статус, без секретных заголовков и query', async () => {
    const records = await call('/webhooks/dokploy?token=QUERYSECRET', {
      'x-botyard-signature': 'SIGSECRET',
      authorization: 'Bearer AUTHSECRET',
      'idempotency-key': 'k-1',
    })
    const text = JSON.stringify(records)
    const completed = records.find((record) => record.msg === 'request completed') as { res: { statusCode: number } }

    expect(completed.res.statusCode).toBe(202)
    expect(text).not.toMatch(/QUERYSECRET|SIGSECRET|AUTHSECRET|DEEPSECRET|TOPKEY|TOPPASS|TOPTOKEN|MSGPASS|MSGBEARER/)
    expect(text).toContain('dokploy failed for postgres://[redacted]@db/x')
    expect(text).toContain('k-1')
  })

  test('ошибка запроса видна в логе, её секреты замаскированы', async () => {
    const records = await call('/boom')
    const errored = records.find((record) => record.msg === 'request errored') as {
      err: { type: string; message: string; cause: { message: string } }
      res: { statusCode: number }
    }

    expect(errored.res.statusCode).toBe(500)
    expect(errored.err.type).toBe('Error')
    expect(errored.err.message).toContain('dokploy said no')
    expect(errored.err.cause.message).toBe('socket hang up')
    expect(JSON.stringify(records)).not.toMatch(/ERRPASS|ERRKEY|CAUSEKEY/)
  })

  test('успешная проба не пишется', async () => {
    expect(await call('/health/live')).toEqual([])
  })

  test('без явного флага логи — JSON, а не pino-pretty', () => {
    expect(options.transport).toBeUndefined()
  })
})
