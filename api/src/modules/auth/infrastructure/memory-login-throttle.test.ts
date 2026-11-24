import { describe, expect, test } from 'bun:test'
import { MemoryLoginThrottle } from './memory-login-throttle'

const rules = [
  { prefix: 'email:', maxAttempts: 3, windowMs: 60_000 },
  { prefix: 'ip:', maxAttempts: 5, windowMs: 60_000 },
]
const keys = (email: string, ip = '10.0.0.1') => [`email:${email}`, `ip:${ip}`]

describe('MemoryLoginThrottle', () => {
  test('резерв до проверки пароля: залп сверх лимита блокируется сразу, а не после хеширования', () => {
    const throttle = new MemoryLoginThrottle(rules)
    const results = Array.from({ length: 10 }, () => throttle.tryAcquire(keys('a@x'), 1_000))

    expect(results.filter((result) => result === null)).toHaveLength(3)
    expect(throttle.tryAcquire(keys('a@x'), 2_000)).toBe(59_000)
    expect(throttle.tryAcquire(keys('a@x'), 61_000)).toBeNull()
  })

  test('перебор почт с одного IP упирается в лимит IP', () => {
    const throttle = new MemoryLoginThrottle(rules)
    for (let i = 0; i < 5; i++) throttle.tryAcquire(keys(`user${i}@x`), 0)

    expect(throttle.tryAcquire(keys('fresh@x'), 10)).not.toBeNull()
    expect(throttle.tryAcquire(keys('fresh@x', '10.0.0.2'), 10)).toBeNull()
  })

  test('успешный вход снимает свой резерв: удачные входы не копят лимит IP', () => {
    const throttle = new MemoryLoginThrottle(rules)
    for (let i = 0; i < 10; i++) {
      expect(throttle.tryAcquire(keys(`ok${i}@x`), 0)).toBeNull()
      throttle.forgive(keys(`ok${i}@x`))
    }

    expect(throttle.tryAcquire(keys('next@x'), 0)).toBeNull()
  })

  test('заблокированная попытка не продлевает и не наращивает счёт', () => {
    const throttle = new MemoryLoginThrottle(rules)
    for (let i = 0; i < 3; i++) throttle.tryAcquire(keys('a@x'), 0)
    for (let i = 0; i < 100; i++) throttle.tryAcquire(keys('a@x'), 30_000)

    expect(throttle.tryAcquire(keys('a@x'), 60_000)).toBeNull()
  })
})
