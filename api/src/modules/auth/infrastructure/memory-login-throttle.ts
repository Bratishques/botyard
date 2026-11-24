import type { LoginThrottle } from '../domain/auth'

export interface ThrottleRule {
  /** Префикс ключа, к которому относится правило: `email:`, `ip:` */
  readonly prefix: string
  readonly maxFailures: number
  readonly windowMs: number
}

export const DEFAULT_LOGIN_RULES: readonly ThrottleRule[] = [
  { prefix: 'email:', maxFailures: 5, windowMs: 15 * 60_000 },
  { prefix: 'ip:', maxFailures: 20, windowMs: 15 * 60_000 },
]

const MAX_KEYS = 10_000

/**
 * Ограничитель неудачных входов в памяти процесса: окно с фиксированным началом на ключ.
 *
 * Ограничение — на реплику: при N репликах злоумышленник получает N лимитов. Для админки с несколькими
 * операторами это приемлемо и записано в модели угроз; общий счётчик (Redis) — при росте числа реплик.
 * Карта ограничена: при переполнении вытесняются старейшие записи, а не растёт память от перебора адресов.
 */
export class MemoryLoginThrottle implements LoginThrottle {
  private readonly failures = new Map<string, { count: number; since: number }>()

  constructor(private readonly rules: readonly ThrottleRule[] = DEFAULT_LOGIN_RULES) {}

  blockedFor(keys: readonly string[], now: number): number | null {
    let longest: number | null = null
    for (const key of keys) {
      const rule = this.ruleFor(key)
      const entry = this.failures.get(key)
      if (!rule || !entry) continue
      if (now - entry.since >= rule.windowMs) {
        this.failures.delete(key)
        continue
      }
      if (entry.count >= rule.maxFailures) longest = Math.max(longest ?? 0, entry.since + rule.windowMs - now)
    }

    return longest
  }

  recordFailure(keys: readonly string[], now: number): void {
    for (const key of keys) {
      const rule = this.ruleFor(key)
      if (!rule) continue
      const entry = this.failures.get(key)
      if (entry && now - entry.since < rule.windowMs) {
        entry.count++
        continue
      }
      if (this.failures.size >= MAX_KEYS) {
        const oldest = this.failures.keys().next().value
        if (oldest !== undefined) this.failures.delete(oldest)
      }
      this.failures.set(key, { count: 1, since: now })
    }
  }

  reset(keys: readonly string[]): void {
    for (const key of keys) this.failures.delete(key)
  }

  private ruleFor(key: string): ThrottleRule | undefined {
    return this.rules.find((rule) => key.startsWith(rule.prefix))
  }
}
