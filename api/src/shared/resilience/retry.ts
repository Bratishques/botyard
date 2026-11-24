/**
 * Повтор внешнего вызова с экспоненциальной задержкой и случайным разбросом.
 *
 * Разброс («full jitter»: случайная задержка от нуля до потолка попытки) нужен, чтобы клиенты,
 * упавшие вместе — например, все воркеры при перезапуске Dokploy, — не возвращались одновременно.
 * Если сервер назвал паузу сам (`Retry-After`), ждём её; пауза длиннее потолка — повтора нет.
 */
export interface RetryPolicy {
  /** Всего попыток, включая первую */
  readonly attempts: number
  readonly baseDelayMs: number
  readonly maxDelayMs: number
}

export const DEFAULT_RETRY: RetryPolicy = { attempts: 3, baseDelayMs: 250, maxDelayMs: 5_000 }

export interface RetryDecision {
  readonly retry: boolean
  /** Пауза, которую попросил сервер */
  readonly retryAfterMs?: number
}

export interface RetryHooks {
  /** Решение по ошибке: повторять ли и не назвал ли сервер паузу */
  classify(error: unknown): RetryDecision
  /** Для тестов: случайность и сон подменяются */
  random?: () => number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  signal?: AbortSignal
}

export function retryDelay(policy: RetryPolicy, attempt: number, random: () => number, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined) return Math.min(retryAfterMs, policy.maxDelayMs)
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1))

  return Math.floor(random() * ceiling)
}

export async function withRetry<T>(policy: RetryPolicy, hooks: RetryHooks, call: (attempt: number) => Promise<T>): Promise<T> {
  const random = hooks.random ?? Math.random
  const sleep = hooks.sleep ?? abortableSleep

  for (let attempt = 1; ; attempt++) {
    try {
      return await call(attempt)
    } catch (error) {
      const decision = hooks.classify(error)
      if (!decision.retry || attempt >= policy.attempts || hooks.signal?.aborted) throw error
      // Сервер просит ждать дольше нашего потолка (у ключа Dokploy бывает сутки): повтор через потолок
      // заведомо получит тот же отказ — отдаём ошибку сразу, пауза остаётся в ней для вызывающего
      if (decision.retryAfterMs !== undefined && decision.retryAfterMs > policy.maxDelayMs) throw error

      await sleep(retryDelay(policy, attempt, random, decision.retryAfterMs), hooks.signal)
    }
  }
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(signal.reason)
      },
      { once: true },
    )
  })
}
