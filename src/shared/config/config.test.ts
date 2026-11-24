import { describe, expect, test } from 'bun:test'
import { loadConfig } from './config'

const base = { DATABASE_URL: 'postgres://u:p@localhost:5432/db' }

describe('loadConfig', () => {
  test('подставляет значения по умолчанию', () => {
    const config = loadConfig(base)

    expect(config.PROCESS_ROLE).toBe('http')
    expect(config.PORT).toBe(4000)
    expect(config.METRICS_PORT).toBe(9464)
  })

  test('не принимает неизвестную роль процесса', () => {
    expect(() => loadConfig({ ...base, PROCESS_ROLE: 'scheduler' })).toThrow(/PROCESS_ROLE/)
  })

  test('не печатает значения в ошибке', () => {
    const secretUrl = 'mysql://user:super-secret@host/db'

    expect(() => loadConfig({ DATABASE_URL: secretUrl })).toThrow(/DATABASE_URL/)
    try {
      loadConfig({ DATABASE_URL: secretUrl })
    } catch (error) {
      expect(String(error)).not.toContain('super-secret')
    }
  })
})
