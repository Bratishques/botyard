import { describe, expect, test } from 'bun:test'
import { loadConfig } from './config'

const base = { DATABASE_URL: 'postgres://u:p@localhost:5432/db', SECRETS_MASTER_KEY: Buffer.alloc(32, 7).toString('base64') }

describe('loadConfig', () => {
  test('подставляет значения по умолчанию', () => {
    const config = loadConfig(base)

    expect(config.PROCESS_ROLE).toBe('http')
    expect(config.PORT).toBe(4000)
    expect(config.METRICS_PORT).toBe(9464)
    expect(config.LOG_PRETTY).toBe(false)
  })

  test('не принимает неизвестную роль процесса', () => {
    expect(() => loadConfig({ ...base, PROCESS_ROLE: 'scheduler' })).toThrow(/PROCESS_ROLE/)
  })

  test('не даёт метрикам и api занять один порт', () => {
    expect(() => loadConfig({ ...base, PORT: '4000', METRICS_PORT: '4000' })).toThrow(/METRICS_PORT: must differ from PORT/)
  })

  test('порт — только целое число', () => {
    expect(() => loadConfig({ ...base, PORT: '1e3' })).toThrow(/PORT/)
  })

  test('pretty-логи включаются только явным флагом', () => {
    expect(loadConfig({ ...base, LOG_PRETTY: 'true' }).LOG_PRETTY).toBe(true)
    expect(() => loadConfig({ ...base, LOG_PRETTY: 'yes' })).toThrow(/LOG_PRETTY/)
  })

  test('мастер-ключ обязателен и ровно 32 байта', () => {
    expect(() => loadConfig({ DATABASE_URL: base.DATABASE_URL })).toThrow(/SECRETS_MASTER_KEY/)
    expect(() => loadConfig({ ...base, SECRETS_MASTER_KEY: Buffer.alloc(16).toString('base64') })).toThrow(/32 bytes/)
    expect(loadConfig(base).SECRETS_MASTER_KEY).toHaveLength(32)
  })

  test('не печатает значения в ошибке', () => {
    const secretUrl = 'mysql://user:super-secret@host/db'

    expect(() => loadConfig({ ...base, DATABASE_URL: secretUrl })).toThrow(/DATABASE_URL/)
    try {
      loadConfig({ ...base, DATABASE_URL: secretUrl })
    } catch (error) {
      expect(String(error)).not.toContain('super-secret')
    }
  })
})
