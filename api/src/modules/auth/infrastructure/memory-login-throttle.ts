import type { LoginThrottle } from '../domain/auth'

export interface ThrottleRule {
  /** Префикс ключа, к которому относится правило: `email:`, `ip:` */
  readonly prefix: string
  readonly maxAttempts: number
  readonly windowMs: number
}

export const DEFAULT_LOGIN_RULES: readonly ThrottleRule[] = [
  { prefix: 'email:', maxAttempts: 5, windowMs: 15 * 60_000 },
  { prefix: 'ip:', maxAttempts: 20, windowMs: 15 * 60_000 },
]

const MAX_KEYS = 10_000

type Entry = { count: number; since: number }

/**
 * Ограничитель входов в памяти процесса: окно с фиксированным началом на ключ.
 *
 * Попытка резервируется ДО проверки пароля, проверка и учёт — один синхронный шаг: залп параллельных
 * запросов не проходит мимо лимита, пока первые ждут argon2 («счёт до защищаемого действия»). Успешный
 * вход снимает свой резерв — счёт остаётся только неудачам.
 *
 * Ограничение — на реплику: при N репликах — N лимитов (общий счётчик — этап 2, docs/roadmap.md).
 * Карта ограничена; при переполнении сначала уходят истёкшие записи, затем IP-ключи, и только потом
 * самые старые — живая блокировка почты не вытесняется перебором адресов.
 */
export class MemoryLoginThrottle implements LoginThrottle {
  private readonly attempts = new Map<string, Entry>()

  constructor(private readonly rules: readonly ThrottleRule[] = DEFAULT_LOGIN_RULES) {}

  tryAcquire(keys: readonly string[], now: number): number | null {
    let blockedFor: number | null = null
    for (const key of keys) {
      const rule = this.ruleFor(key)
      const entry = this.live(key, now)
      if (rule && entry && entry.count >= rule.maxAttempts) blockedFor = Math.max(blockedFor ?? 0, entry.since + rule.windowMs - now)
    }
    if (blockedFor !== null) return blockedFor

    for (const key of keys) {
      if (!this.ruleFor(key)) continue
      const entry = this.live(key, now)
      if (entry) entry.count++
      else this.insert(key, { count: 1, since: now }, now)
    }

    return null
  }

  forgive(keys: readonly string[]): void {
    for (const key of keys) {
      const entry = this.attempts.get(key)
      if (!entry) continue
      if (entry.count <= 1) this.attempts.delete(key)
      else entry.count--
    }
  }

  reset(keys: readonly string[]): void {
    for (const key of keys) this.attempts.delete(key)
  }

  /** Запись ключа, если её окно ещё не истекло; истёкшая удаляется */
  private live(key: string, now: number): Entry | null {
    const entry = this.attempts.get(key)
    const rule = this.ruleFor(key)
    if (!entry || !rule) return null
    if (now - entry.since >= rule.windowMs) {
      this.attempts.delete(key)
      return null
    }

    return entry
  }

  private insert(key: string, entry: Entry, now: number): void {
    if (this.attempts.size >= MAX_KEYS) this.evict(now)
    this.attempts.set(key, entry)
  }

  private evict(now: number): void {
    for (const key of [...this.attempts.keys()]) this.live(key, now)
    if (this.attempts.size < MAX_KEYS) return

    for (const key of this.attempts.keys()) {
      if (key.startsWith('ip:')) {
        this.attempts.delete(key)
        return
      }
    }
    const oldest = this.attempts.keys().next().value
    if (oldest !== undefined) this.attempts.delete(oldest)
  }

  private ruleFor(key: string): ThrottleRule | undefined {
    return this.rules.find((rule) => key.startsWith(rule.prefix))
  }
}
