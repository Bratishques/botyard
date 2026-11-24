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

  test('безопасные умолчания для прода', () => {
    const config = loadConfig(base)

    expect(config.SESSION_COOKIE_SECURE).toBe(true)
    expect(config.DESTINATIONS_ALLOW_HTTP).toBe(false)
    expect(config.SESSION_TTL_HOURS).toBe(12)
    expect(config.TRUST_PROXY).toBe(false)
  })

  test('TRUST_PROXY: число хопов или подсети, но не true', () => {
    expect(loadConfig({ ...base, TRUST_PROXY: '1' }).TRUST_PROXY).toBe(1)
    expect(loadConfig({ ...base, TRUST_PROXY: '10.0.0.0/8, 172.16.0.0/12' }).TRUST_PROXY).toEqual(['10.0.0.0/8', '172.16.0.0/12'])
    expect(() => loadConfig({ ...base, TRUST_PROXY: 'true' })).toThrow(/TRUST_PROXY/)
    expect(loadConfig({ ...base, TRUST_PROXY: '::1, 10.0.0.1' }).TRUST_PROXY).toEqual(['::1', '10.0.0.1'])
    // proxy-addr прочёл бы `100` и `1,2` как адреса и молча перестал бы доверять; /1 — почти `true`
    for (const value of ['100', '1,2', 'yes', 'TRUE', ' true', '0.0.0.0/1', '10.0.0.0/7', '10.0.0.0/33', 'traefik']) {
      expect(() => loadConfig({ ...base, TRUST_PROXY: value })).toThrow(/TRUST_PROXY/)
    }
  })

  test('срок сессии ограничен 1..720 часами', () => {
    expect(() => loadConfig({ ...base, SESSION_TTL_HOURS: '0' })).toThrow(/SESSION_TTL_HOURS/)
    expect(() => loadConfig({ ...base, SESSION_TTL_HOURS: '721' })).toThrow(/SESSION_TTL_HOURS/)
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
