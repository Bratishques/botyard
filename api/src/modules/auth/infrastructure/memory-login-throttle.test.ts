import { describe, expect, test } from 'bun:test'
import { MemoryLoginThrottle } from './memory-login-throttle'

const rules = [
  { prefix: 'email:', maxFailures: 3, windowMs: 60_000 },
  { prefix: 'ip:', maxFailures: 5, windowMs: 60_000 },
]
const keys = (email: string, ip = '10.0.0.1') => [`email:${email}`, `ip:${ip}`]

describe('MemoryLoginThrottle', () => {
  test('после лимита неудач по почте блокирует до конца окна, затем отпускает', () => {
    const throttle = new MemoryLoginThrottle(rules)
    for (let i = 0; i < 3; i++) throttle.recordFailure(keys('a@x'), 1_000)

    expect(throttle.blockedFor(keys('a@x'), 2_000)).toBe(59_000)
    expect(throttle.blockedFor(keys('a@x'), 61_000)).toBeNull()
  })

  test('перебор почт с одного IP упирается в лимит IP', () => {
    const throttle = new MemoryLoginThrottle(rules)
    for (let i = 0; i < 5; i++) throttle.recordFailure(keys(`user${i}@x`), 0)

    expect(throttle.blockedFor(keys('fresh@x'), 10)).not.toBeNull()
    expect(throttle.blockedFor(keys('fresh@x', '10.0.0.2'), 10)).toBeNull()
  })

  test('успешный вход сбрасывает счётчик почты', () => {
    const throttle = new MemoryLoginThrottle(rules)
    for (let i = 0; i < 2; i++) throttle.recordFailure(keys('a@x'), 0)
    throttle.reset(['email:a@x'])
    throttle.recordFailure(keys('a@x'), 0)

    expect(throttle.blockedFor(keys('a@x'), 0)).toBeNull()
  })
})
