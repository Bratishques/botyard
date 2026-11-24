import { describe, expect, test } from 'bun:test'
import { parseLogs } from './deployment-logs'

describe('логи робота', () => {
  test('строки по времени, токен клиента вычищен точно и маской; строки без времени отброшены', () => {
    const raw = [
      '2026-11-24T21:24:37.182885647Z {"level":"FATAL","message":"token t.client-secret-0123456789 rejected"}',
      '2026-11-24T21:24:30.869326431Z {"level":"INFO","message":"start"}',
      'garbage without time',
      '2026-11-24T21:24:31.000000000Z other t.some-other-token-0123456789',
      '',
    ].join('\n')

    const lines = parseLogs(raw, ['t.client-secret-0123456789'])

    expect(lines.map((line) => line.at)).toEqual([
      '2026-11-24T21:24:30.869326431Z',
      '2026-11-24T21:24:31.000000000Z',
      '2026-11-24T21:24:37.182885647Z',
    ])
    expect(JSON.stringify(lines)).not.toContain('client-secret')
    expect(JSON.stringify(lines)).not.toContain('some-other-token')
    expect(lines[2]?.text).toContain('<secret>')
  })
})
