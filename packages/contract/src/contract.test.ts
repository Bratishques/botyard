import { describe, expect, test } from 'bun:test'
import {
  customerCreateSchema,
  DEPLOYMENT_ACTIONS,
  deploymentCreateSchema,
  destinationCreateSchema,
  IDEMPOTENCY_KEY,
  versionSchema,
} from './index'

describe('контракт API', () => {
  test('токен клиента: печатные ASCII без пробелов, не короче 16; лишние поля запрещены', () => {
    const base = { name: 'Клиент', accountId: 'acc-1' }
    expect(customerCreateSchema.safeParse({ ...base, token: 't.valid-token-0123456789' }).success).toBe(true)
    expect(customerCreateSchema.safeParse({ ...base, token: 't.with space 0123456789' }).success).toBe(false)
    expect(customerCreateSchema.safeParse({ ...base, token: 't.кириллица-0123456789' }).success).toBe(false)
    expect(customerCreateSchema.safeParse({ ...base, token: 't.short' }).success).toBe(false)
    expect(customerCreateSchema.safeParse({ ...base, token: 't.valid-token-0123456789', sandbox: false }).success).toBe(false)
  })

  test('назначение: serverId по умолчанию null; развёртывание: id — uuid, шаблон — slug', () => {
    const destination = destinationCreateSchema.parse({ name: 'd', baseUrl: 'https://x', apiKey: 'k'.repeat(16), environmentId: 'env' })
    expect(destination.serverId).toBeNull()

    const uuid = '01a20f17-2637-7706-b26e-0e3ff24355ae'
    expect(deploymentCreateSchema.safeParse({ customerId: uuid, destinationId: uuid, templateId: 'bita', config: {} }).success).toBe(true)
    expect(deploymentCreateSchema.safeParse({ customerId: 'x', destinationId: uuid, templateId: 'bita', config: {} }).success).toBe(false)
    expect(deploymentCreateSchema.safeParse({ customerId: uuid, destinationId: uuid, templateId: 'Bita!', config: {} }).success).toBe(false)
  })

  test('версия — положительное целое; ключ идемпотентности — 8–128 безопасных символов; действия — четыре', () => {
    expect(versionSchema.safeParse({ version: 0 }).success).toBe(false)
    expect(IDEMPOTENCY_KEY.test('key-1234')).toBe(true)
    expect(IDEMPOTENCY_KEY.test('short')).toBe(false)
    expect(Object.keys(DEPLOYMENT_ACTIONS)).toEqual(['start', 'stop', 'redeploy', 'delete'])
  })
})
