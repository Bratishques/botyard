import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { KeyEncryptionKey } from './key-encryption-key'

/**
 * Конверт секрета (envelope encryption).
 *
 *   секрет ──AES-256-GCM(DEK, AAD)──► шифртекст
 *   DEK    ──KEK──────────────────► обёрнутый DEK
 *
 * Формат v1, всё в одном bytea:
 *
 *   [1] версия формата = 1
 *   [1] id мастер-ключа
 *   [2] длина обёрнутого DEK, big-endian
 *   [n] обёрнутый DEK
 *   [12] iv  [16] tag  [..] шифртекст секрета
 *
 * AAD — контекст секрета (`destination:<id>:api_key`). Он не хранится в конверте, а передаётся
 * при расшифровке: конверт одной строки, переложенный в другую, не расшифруется. Так подмена
 * секрета между записями ловится криптографией, а не надеждой на код.
 */
export class SecretBox {
  private readonly current: KeyEncryptionKey
  private readonly byId: ReadonlyMap<number, KeyEncryptionKey>

  /** Первый ключ — текущий, им шифруются новые секреты. Остальные нужны только для чтения старых */
  constructor(keys: readonly KeyEncryptionKey[]) {
    const [current] = keys
    if (!current) throw new Error('at least one master key is required')
    const byId = new Map(keys.map((key) => [key.id, key]))
    if (byId.size !== keys.length) throw new Error('master key ids must be unique')

    this.current = current
    this.byId = byId
  }

  async seal(secret: string, context: string): Promise<Uint8Array> {
    const dataKey = randomBytes(32)
    try {
      const iv = randomBytes(IV_BYTES)
      const cipher = createCipheriv('aes-256-gcm', dataKey, iv)
      cipher.setAAD(Buffer.from(context, 'utf8'))
      const body = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
      const wrapped = await this.current.wrap(dataKey)

      const header = Buffer.alloc(4)
      header.writeUInt8(FORMAT_V1, 0)
      header.writeUInt8(this.current.id, 1)
      header.writeUInt16BE(wrapped.length, 2)

      return Buffer.concat([header, wrapped, iv, cipher.getAuthTag(), body])
    } finally {
      dataKey.fill(0)
    }
  }

  async open(sealed: Uint8Array, context: string): Promise<string> {
    const bytes = Buffer.from(sealed)
    if (bytes.length < 4 || bytes.readUInt8(0) !== FORMAT_V1) throw new SecretBoxError('unsupported envelope format')

    const kek = this.byId.get(bytes.readUInt8(1))
    if (!kek) throw new SecretBoxError(`master key ${bytes.readUInt8(1)} is not configured`)

    const wrappedEnd = 4 + bytes.readUInt16BE(2)
    if (bytes.length < wrappedEnd + IV_BYTES + TAG_BYTES) throw new SecretBoxError('truncated envelope')

    let dataKey: Uint8Array | undefined
    try {
      dataKey = await kek.unwrap(bytes.subarray(4, wrappedEnd))
      const iv = bytes.subarray(wrappedEnd, wrappedEnd + IV_BYTES)
      const tag = bytes.subarray(wrappedEnd + IV_BYTES, wrappedEnd + IV_BYTES + TAG_BYTES)
      const decipher = createDecipheriv('aes-256-gcm', dataKey, iv)
      decipher.setAAD(Buffer.from(context, 'utf8'))
      decipher.setAuthTag(tag)

      return Buffer.concat([decipher.update(bytes.subarray(wrappedEnd + IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8')
    } catch (error) {
      if (error instanceof SecretBoxError) throw error
      // Причину не раскрываем: «не тот ключ», «не тот контекст» и «испорчено» для вызывающего одинаковы
      throw new SecretBoxError('envelope cannot be opened')
    } finally {
      dataKey?.fill(0)
    }
  }
}

export class SecretBoxError extends Error {
  override readonly name = 'SecretBoxError'
}

/** Подсказка для оператора: последние символы, по которым он узнает ключ в списке */
export function secretHint(secret: string, visible = 4): string {
  return secret.length <= visible * 2 ? '••••' : `••••${secret.slice(-visible)}`
}

const FORMAT_V1 = 1
const IV_BYTES = 12
const TAG_BYTES = 16
