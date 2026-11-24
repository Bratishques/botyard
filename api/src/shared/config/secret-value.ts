import { inspect } from 'node:util'

/**
 * Секрет из окружения внутри объекта конфига. Значение достаётся только явным `reveal()`:
 * `JSON.stringify`, `console.log` и `Bun.inspect` конфига печатают маску, а не байты ключа.
 */
export class SecretValue {
  readonly #value: Buffer

  constructor(value: Buffer) {
    this.#value = Buffer.from(value)
  }

  /** Копия: изменение полученного буфера не трогает хранимый ключ */
  reveal(): Buffer {
    return Buffer.from(this.#value)
  }

  get length(): number {
    return this.#value.length
  }

  toJSON(): string {
    return '[redacted]'
  }

  toString(): string {
    return '[redacted]'
  }

  [inspect.custom](): string {
    return 'SecretValue [redacted]'
  }
}
