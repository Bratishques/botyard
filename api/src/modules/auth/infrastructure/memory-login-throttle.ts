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
/** Пауза для попытки, которой не нашлось места: карта занята живыми блокировками */
const FULL_RETRY_MS = 60_000

type Entry = { count: number; since: number }

/**
 * Ограничитель входов в памяти процесса: окно с фиксированным началом на ключ.
 *
 * Попытка резервируется ДО проверки пароля, проверка и учёт — один синхронный шаг: залп параллельных
 * запросов не проходит мимо лимита, пока первые ждут argon2 («счёт до защищаемого действия»). Успешный
 * вход снимает свой резерв — счёт остаётся только неудачам.
 *
 * Ограничение — на реплику: при N репликах — N лимитов (общий счётчик — этап 2, docs/roadmap.md).
 * Карта ограничена; при переполнении уходят истёкшие и незаблокированные записи, а живые блокировки —
 * никогда: перебор чужих почт или адресов не снимает блокировку жертвы раньше окна.
 */
export class MemoryLoginThrottle implements LoginThrottle {
  private readonly attempts = new Map<string, Entry>()

  constructor(
    private readonly rules: readonly ThrottleRule[] = DEFAULT_LOGIN_RULES,
    private readonly maxKeys = MAX_KEYS,
  ) {}

  tryAcquire(keys: readonly string[], now: number): number | null {
    let blockedFor: number | null = null
    for (const key of keys) {
      const rule = this.ruleFor(key)
      const entry = this.live(key, now)
      if (rule && entry && entry.count >= rule.maxAttempts) blockedFor = Math.max(blockedFor ?? 0, entry.since + rule.windowMs - now)
    }
    if (blockedFor !== null) return blockedFor

    const missing = keys.filter((key) => this.ruleFor(key) && !this.attempts.has(key)).length
    // Места нет, а освобождать его за счёт живых блокировок нельзя — попытка не допускается
    if (!this.ensureCapacity(missing, now)) return FULL_RETRY_MS

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

  private insert(key: string, entry: Entry, _now: number): void {
    this.attempts.set(key, entry)
  }

  /**
   * Место под `needed` новых ключей. Порядок вытеснения: истёкшие записи, затем незаблокированные с
   * наименьшим счётом — пачкой до 90% ёмкости, чтобы не делать полный проход на каждой вставке.
   * Заблокированные (счёт достиг лимита) не вытесняются никогда: иначе перебор чужих ключей снимал бы
   * блокировку жертвы раньше окна.
   */
  private ensureCapacity(needed: number, now: number): boolean {
    if (this.attempts.size + needed <= this.maxKeys) return true

    for (const key of [...this.attempts.keys()]) this.live(key, now)
    if (this.attempts.size + needed <= this.maxKeys) return true

    const evictable = [...this.attempts.entries()]
      .filter(([key, entry]) => entry.count < (this.ruleFor(key)?.maxAttempts ?? 0))
      .sort(([, a], [, b]) => a.count - b.count)
    const target = Math.floor(this.maxKeys * 0.9)
    for (const [key] of evictable) {
      if (this.attempts.size + needed <= target) break
      this.attempts.delete(key)
    }

    return this.attempts.size + needed <= this.maxKeys
  }

  private ruleFor(key: string): ThrottleRule | undefined {
    return this.rules.find((rule) => key.startsWith(rule.prefix))
  }
}
