/**
 * Ключ идемпотентности на попытку пользователя.
 *
 * Попытка начинается, когда оператор открыл форму или диалог действия, и заканчивается подтверждённым успехом.
 * Внутри неё ключ один: повтор после обрыва или ошибки уходит с тем же ключом, и API вернёт прежний ответ,
 * если первый запрос на самом деле прошёл, — вторая операция не создаётся. Ключ не привязан к телу: если
 * оператор поменял данные после попытки, которая могла пройти, API ответит `409 IDEMPOTENCY_CONFLICT`, и это
 * правильно — сначала надо посмотреть, что получилось. Ошибки API не запоминает, поэтому исправление после
 * отказа (неверный конфиг) с тем же ключом проходит как новый запрос.
 */
import { useState } from 'react'

export function newIdempotencyKey(): string {
  // UUID — 36 символов из `0-9 a-f -`: укладывается в формат ключа API (8–128 символов `A-Za-z0-9-_`)
  return crypto.randomUUID()
}

/** Где пережить перезагрузку страницы (`sessionStorage`); в тестах — подделка */
export interface KeyStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export class Attempt {
  private current: string

  /**
   * `persist` — имя ключа в хранилище: попытка переживает перезагрузку страницы. Нужно там, где у запроса нет
   * `version` для защиты от дубля (создание): после «Нет связи» оператор обновит страницу, и новый ключ создал бы
   * второго робота, если первый запрос на самом деле прошёл. Ключ не секрет; хранилище недоступно — только память
   */
  constructor(private readonly persist?: { name: string; store: KeyStore | undefined }) {
    this.current = this.load() ?? newIdempotencyKey()
    this.save(this.current)
  }

  get key(): string {
    return this.current
  }

  /** Выполнить запрос попытки; после подтверждённого успеха следующая попытка получит новый ключ */
  async run<T>(send: (key: string) => Promise<T>): Promise<T> {
    const key = this.current
    const result = await send(key)
    if (this.current === key) {
      this.current = newIdempotencyKey()
      this.save(this.current)
    }
    return result
  }

  private load(): string | null {
    if (!this.persist?.store) return null
    try {
      const saved = this.persist.store.getItem(this.persist.name)
      return saved && /^[A-Za-z0-9_-]{8,128}$/.test(saved) ? saved : null
    } catch {
      return null
    }
  }

  private save(key: string): void {
    if (!this.persist?.store) return
    try {
      this.persist.store.setItem(this.persist.name, key)
    } catch {
      // Хранилище закрыто (приватный режим) — попытка живёт в памяти
    }
  }
}

function sessionStore(): KeyStore | undefined {
  try {
    return typeof sessionStorage === 'undefined' ? undefined : sessionStorage
  } catch {
    return undefined
  }
}

/**
 * Попытка живёт, пока смонтирован компонент: форма или диалог открыты — ключ создан при открытии. С `persist` —
 * и после перезагрузки вкладки, до подтверждённого успеха
 */
export function useAttempt(persist?: string): Attempt {
  const [attempt] = useState(() => new Attempt(persist ? { name: `botyard:attempt:${persist}`, store: sessionStore() } : undefined))
  return attempt
}
