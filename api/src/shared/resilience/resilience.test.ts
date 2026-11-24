import { describe, expect, test } from 'bun:test'
import { CircuitBreaker, CircuitOpenError } from './circuit-breaker'
import { retryDelay, withRetry } from './retry'

const policy = { attempts: 4, baseDelayMs: 100, maxDelayMs: 1_000 }
const noSleep = async () => {}

describe('withRetry', () => {
  test('повторяет повторяемое и возвращает первый успех', async () => {
    const calls: number[] = []
    const result = await withRetry(policy, { classify: () => ({ retry: true }), sleep: noSleep }, async (attempt) => {
      calls.push(attempt)
      if (attempt < 3) throw new Error('503')
      return 'ok'
    })

    expect(result).toBe('ok')
    expect(calls).toEqual([1, 2, 3])
  })

  test('неповторяемую ошибку отдаёт сразу', async () => {
    let calls = 0
    const failing = withRetry(policy, { classify: () => ({ retry: false }), sleep: noSleep }, async () => {
      calls++
      throw new Error('401')
    })

    await expect(failing).rejects.toThrow('401')
    expect(calls).toBe(1)
  })

  test('после последней попытки отдаёт последнюю ошибку', async () => {
    let calls = 0
    const failing = withRetry(policy, { classify: () => ({ retry: true }), sleep: noSleep }, async () => {
      calls++
      throw new Error(`fail ${calls}`)
    })

    await expect(failing).rejects.toThrow('fail 4')
    expect(calls).toBe(4)
  })

  test('ждёт паузу, названную сервером', async () => {
    const slept: number[] = []
    await withRetry(
      policy,
      { classify: () => ({ retry: true, retryAfterMs: 700 }), sleep: async (ms) => void slept.push(ms) },
      async (attempt) => {
        if (attempt === 1) throw new Error('429')
        return 'ok'
      },
    )

    expect(slept).toEqual([700])
  })
})

describe('retryDelay', () => {
  test('потолок растёт экспоненциально и упирается в максимум, разброс — от нуля до потолка', () => {
    const top = () => 0.999999

    expect(retryDelay(policy, 1, top)).toBe(99)
    expect(retryDelay(policy, 3, top)).toBe(399)
    expect(retryDelay(policy, 10, top)).toBe(999)
    expect(retryDelay(policy, 3, () => 0)).toBe(0)
  })

  test('пауза сервера не длиннее максимума', () => {
    expect(retryDelay(policy, 1, Math.random, 60_000)).toBe(1_000)
  })
})

describe('CircuitBreaker', () => {
  const fail = async () => {
    throw new Error('down')
  }
  const always = () => true

  test('размыкается после порога и не зовёт адресата, пока открыта', async () => {
    let now = 0
    const breaker = new CircuitBreaker({ failureThreshold: 2, openMs: 1_000, now: () => now })
    let calls = 0
    const counted = async () => {
      calls++
      throw new Error('down')
    }

    await expect(breaker.run(counted, always)).rejects.toThrow('down')
    await expect(breaker.run(counted, always)).rejects.toThrow('down')
    await expect(breaker.run(counted, always)).rejects.toBeInstanceOf(CircuitOpenError)
    expect(calls).toBe(2)

    now = 1_000
    expect(breaker.status).toBe('half-open')
  })

  test('half-open пропускает один пробный вызов; успех замыкает, отказ снова размыкает', async () => {
    let now = 0
    const breaker = new CircuitBreaker({ failureThreshold: 1, openMs: 1_000, now: () => now })
    await expect(breaker.run(fail, always)).rejects.toThrow('down')

    now = 1_000
    let release: () => void = () => {}
    const probe = breaker.run(() => new Promise<string>((resolve) => (release = () => resolve('ok'))), always)
    await expect(breaker.run(async () => 'second', always)).rejects.toBeInstanceOf(CircuitOpenError)
    release()
    expect(await probe).toBe('ok')
    expect(breaker.status).toBe('closed')

    await expect(breaker.run(fail, always)).rejects.toThrow('down')
    now = 2_000
    await expect(breaker.run(fail, always)).rejects.toThrow('down')
    expect(breaker.status).toBe('open')
  })

  test('ошибка вызывающего (неверный ключ) цепь не размыкает', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, openMs: 1_000, now: () => 0 })

    await expect(breaker.run(fail, () => false)).rejects.toThrow('down')
    expect(breaker.status).toBe('closed')
  })
})
