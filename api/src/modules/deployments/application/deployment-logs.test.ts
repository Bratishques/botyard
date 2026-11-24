import { describe, expect, test } from 'bun:test'
import { linesAfter, parseLogs, sinceSecondsFor } from './deployment-logs'

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

  test('поток: окно с запасом отдаёт старые строки снова — отсекаются; строки с тем же временем, но новым текстом — нет', () => {
    const t1 = '2026-11-24T21:24:30.000000000Z'
    const t2 = '2026-11-24T21:24:31.000000000Z'
    const first = linesAfter(
      [
        { at: t1, text: 'a' },
        { at: t2, text: 'b' },
      ],
      null,
    )
    expect(first.fresh.map((line) => line.text)).toEqual(['a', 'b'])

    // Следующий опрос: окно захватило уже отданное, плюс в ту же наносекунду пришла ещё строка, плюс новая
    const next = linesAfter(
      [
        { at: t1, text: 'a' },
        { at: t2, text: 'b' },
        { at: t2, text: 'c' },
        { at: '2026-11-24T21:24:32.000000000Z', text: 'd' },
      ],
      first.cursor,
    )
    expect(next.fresh.map((line) => line.text)).toEqual(['c', 'd'])
    expect(linesAfter([], next.cursor)).toEqual({ fresh: [], cursor: next.cursor })
  })

  test('окно since — секунды с последней отданной строки плюс запас; без курсора — без окна', () => {
    const cursor = { at: '2026-11-24T21:24:30.000000000Z', texts: new Set(['a']) }
    expect(sinceSecondsFor(null)).toBeUndefined()
    expect(sinceSecondsFor(cursor, Date.parse('2026-11-24T21:24:32.100Z'))).toBe(3 + 5)
    // Часы Docker впереди наших — не меньше секунды
    expect(sinceSecondsFor(cursor, Date.parse('2026-11-24T21:24:00Z'))).toBe(1)
  })
})
