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

export class Attempt {
  private current = newIdempotencyKey()

  get key(): string {
    return this.current
  }

  /** Выполнить запрос попытки; после подтверждённого успеха следующая попытка получит новый ключ */
  async run<T>(send: (key: string) => Promise<T>): Promise<T> {
    const key = this.current
    const result = await send(key)
    if (this.current === key) this.current = newIdempotencyKey()
    return result
  }
}

/** Попытка живёт, пока смонтирован компонент: форма или диалог открыты — ключ создан при открытии */
export function useAttempt(): Attempt {
  const [attempt] = useState(() => new Attempt())
  return attempt
}
