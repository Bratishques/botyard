import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/**
 * Ключ шифрования ключей (KEK). Им шифруются только ключи данных, а не сами секреты.
 *
 * Порт, а не функция: локальный ключ из окружения — реализация для стенда. В проде её заменяет KMS
 * или Vault Transit, и мастер-ключ вообще не попадает в память процесса. Формат конверта при этом
 * не меняется, перешифровывать сохранённые секреты не нужно.
 */
export interface KeyEncryptionKey {
  /** Номер ключа в конверте: по нему расшифровка выбирает KEK после ротации */
  readonly id: number
  wrap(dataKey: Uint8Array): Promise<Uint8Array>
  unwrap(wrapped: Uint8Array): Promise<Uint8Array>
}

export const KEY_ENCRYPTION_KEYS = Symbol('KEY_ENCRYPTION_KEYS')

const IV_BYTES = 12
const TAG_BYTES = 16

/** AES-256-GCM с ключом из окружения. Обёртка ключа данных: iv ‖ tag ‖ шифртекст */
export class LocalKeyEncryptionKey implements KeyEncryptionKey {
  private readonly key: Buffer

  constructor(
    readonly id: number,
    key: Uint8Array,
  ) {
    if (key.length !== 32) throw new Error(`master key ${id} must be 32 bytes, got ${key.length}`)
    if (!Number.isInteger(id) || id < 1 || id > 255) throw new Error('master key id must be 1..255')
    this.key = Buffer.from(key)
  }

  async wrap(dataKey: Uint8Array): Promise<Uint8Array> {
    const iv = randomBytes(IV_BYTES)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    const body = Buffer.concat([cipher.update(dataKey), cipher.final()])

    return Buffer.concat([iv, cipher.getAuthTag(), body])
  }

  async unwrap(wrapped: Uint8Array): Promise<Uint8Array> {
    const bytes = Buffer.from(wrapped)
    const decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, IV_BYTES))
    decipher.setAuthTag(bytes.subarray(IV_BYTES, IV_BYTES + TAG_BYTES))

    return Buffer.concat([decipher.update(bytes.subarray(IV_BYTES + TAG_BYTES)), decipher.final()])
  }
}
