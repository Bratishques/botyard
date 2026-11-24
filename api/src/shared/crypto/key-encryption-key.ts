import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/**
 * Ключ шифрования ключей (KEK). Им шифруются только ключи данных, а не сами секреты.
 *
 * Порт, а не функция: локальный ключ из окружения — реализация для стенда. Возможная замена —
 * KMS или Vault Transit, тогда мастер-ключ не попадает в память процесса, а формат конверта
 * не меняется. Такой реализации пока нет.
 */
export interface KeyEncryptionKey {
  /** Номер ключа в конверте: по нему расшифровка выбирает KEK */
  readonly id: number
  /** `aad` — заголовок конверта: обёртка привязана к версии формата и номеру ключа */
  wrap(dataKey: Uint8Array, aad: Uint8Array): Promise<Uint8Array>
  unwrap(wrapped: Uint8Array, aad: Uint8Array): Promise<Uint8Array>
}

export const DATA_KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16
/** iv ‖ tag ‖ зашифрованный ключ данных */
export const LOCAL_WRAPPED_BYTES = IV_BYTES + TAG_BYTES + DATA_KEY_BYTES

/** AES-256-GCM с ключом из окружения */
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

  async wrap(dataKey: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
    if (dataKey.length !== DATA_KEY_BYTES) throw new Error(`data key must be ${DATA_KEY_BYTES} bytes`)
    const iv = randomBytes(IV_BYTES)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv, { authTagLength: TAG_BYTES })
    cipher.setAAD(aad)
    const body = Buffer.concat([cipher.update(dataKey), cipher.final()])

    return Buffer.concat([iv, cipher.getAuthTag(), body])
  }

  async unwrap(wrapped: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
    // Длины проверяются явно, а не доверяются рантайму: Node без authTagLength принимает короткий тег
    if (wrapped.length !== LOCAL_WRAPPED_BYTES) throw new Error('wrapped data key has wrong length')
    const bytes = Buffer.from(wrapped)
    const decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, IV_BYTES), { authTagLength: TAG_BYTES })
    decipher.setAAD(aad)
    decipher.setAuthTag(bytes.subarray(IV_BYTES, IV_BYTES + TAG_BYTES))

    return Buffer.concat([decipher.update(bytes.subarray(IV_BYTES + TAG_BYTES)), decipher.final()])
  }
}
