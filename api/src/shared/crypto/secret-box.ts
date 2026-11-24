import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { DATA_KEY_BYTES, type KeyEncryptionKey } from './key-encryption-key'

/**
 * Конверт секрета (envelope encryption).
 *
 *   секрет ──AES-256-GCM(DEK, AAD = заголовок ‖ контекст)──► шифртекст
 *   DEK    ──KEK(AAD = заголовок)──────────────────────────► обёрнутый DEK
 *
 * Формат v1, всё в одном bytea:
 *
 *   [1] версия формата = 1     ┐ входят в AAD обоих слоёв
 *   [1] id мастер-ключа         ┘
 *   [2] длина обёрнутого DEK, big-endian — входит в AAD шифртекста секрета
 *   [n] обёрнутый DEK
 *   [12] iv  [16] tag  [..] шифртекст секрета
 *
 * Контекст (`secretContext`) не хранится в конверте, а передаётся при расшифровке. В него входит
 * не только запись, но и то, куда секрет уйдёт: для ключа Dokploy — адрес назначения. Конверт,
 * переложенный в другую строку, не откроется, и подмена `base_url` в базе не отправит ключ на
 * чужой хост — смена адреса требует ввести ключ заново.
 *
 * Модель угроз: дамп базы или запись в неё без доступа к процессу. Атакующий с доступом к процессу
 * или к окружению (там мастер-ключ) этим не останавливается.
 */
export class SecretBox {
  private readonly current: KeyEncryptionKey
  private readonly byId: ReadonlyMap<number, KeyEncryptionKey>

  /**
   * Первый ключ — текущий, им шифруются новые секреты; остальные — только для чтения старых.
   * Сейчас конфиг передаёт ровно один ключ: ротация с перешифровкой не реализована (docs/architecture.md).
   */
  constructor(keys: readonly KeyEncryptionKey[]) {
    const [current] = keys
    if (!current) throw new Error('at least one master key is required')
    const byId = new Map(keys.map((key) => [key.id, key]))
    if (byId.size !== keys.length) throw new Error('master key ids must be unique')

    this.current = current
    this.byId = byId
  }

  async seal(secret: string, context: SecretContext): Promise<Uint8Array> {
    const dataKey = randomBytes(DATA_KEY_BYTES)
    try {
      const header = Buffer.alloc(HEADER_BYTES)
      header.writeUInt8(FORMAT_V1, 0)
      header.writeUInt8(this.current.id, 1)
      const wrapped = await this.current.wrap(dataKey, header.subarray(0, 2))
      header.writeUInt16BE(wrapped.length, 2)

      const iv = randomBytes(IV_BYTES)
      const cipher = createCipheriv('aes-256-gcm', dataKey, iv, { authTagLength: TAG_BYTES })
      cipher.setAAD(Buffer.concat([header, Buffer.from(context.value, 'utf8')]))
      const body = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])

      return Buffer.concat([header, wrapped, iv, cipher.getAuthTag(), body])
    } finally {
      // По возможности: копии ключа остаются внутри шифра до сборки мусора
      dataKey.fill(0)
    }
  }

  async open(sealed: Uint8Array, context: SecretContext): Promise<string> {
    const bytes = Buffer.from(sealed)
    if (bytes.length < HEADER_BYTES || bytes.readUInt8(0) !== FORMAT_V1) throw new SecretBoxError('unsupported envelope format')

    const kek = this.byId.get(bytes.readUInt8(1))
    if (!kek) throw new SecretBoxError(`master key ${bytes.readUInt8(1)} is not configured`)

    const header = bytes.subarray(0, HEADER_BYTES)
    const wrappedEnd = HEADER_BYTES + bytes.readUInt16BE(2)
    if (bytes.length < wrappedEnd + IV_BYTES + TAG_BYTES) throw new SecretBoxError('truncated envelope')

    let dataKey: Uint8Array | undefined
    try {
      dataKey = await kek.unwrap(bytes.subarray(HEADER_BYTES, wrappedEnd), header.subarray(0, 2))
      if (dataKey.length !== DATA_KEY_BYTES) throw new SecretBoxError('envelope cannot be opened')

      const iv = bytes.subarray(wrappedEnd, wrappedEnd + IV_BYTES)
      const tag = bytes.subarray(wrappedEnd + IV_BYTES, wrappedEnd + IV_BYTES + TAG_BYTES)
      const decipher = createDecipheriv('aes-256-gcm', dataKey, iv, { authTagLength: TAG_BYTES })
      decipher.setAAD(Buffer.concat([header, Buffer.from(context.value, 'utf8')]))
      decipher.setAuthTag(tag)

      return Buffer.concat([decipher.update(bytes.subarray(wrappedEnd + IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8')
    } catch {
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

declare const secretContextBrand: unique symbol

/** Контекст секрета: строится только через `secretContext`, литерал `{ value }` не пройдёт проверку типов */
export interface SecretContext {
  readonly value: string
  readonly [secretContextBrand]: true
}

const CONTEXT_PART = /^[A-Za-z0-9._:/@-]+$/

/**
 * Контекст секрета: сущность, её id, поле и то, к чему секрет привязан по смыслу (адрес
 * назначения). Пустая или постоянная часть отменила бы привязку к записи, поэтому каждая
 * часть обязательна и проверяется.
 */
export function secretContext(entity: string, id: string, field: string, ...bindings: string[]): SecretContext {
  for (const part of [entity, id, field, ...bindings]) {
    if (!CONTEXT_PART.test(part)) throw new Error(`invalid secret context part: ${JSON.stringify(part.slice(0, 40))}`)
  }

  return { value: [entity, id, field, ...bindings].join('|') } as SecretContext
}

/**
 * Подсказка для оператора: последние символы, по которым он узнает ключ в списке. Для короткого
 * секрета хвост — слишком большая его доля, поэтому подсказки нет.
 */
export function secretHint(secret: string): string {
  return secret.length < MIN_HINTED_LENGTH ? '••••' : `••••${secret.slice(-HINT_VISIBLE)}`
}

const MIN_HINTED_LENGTH = 16
const HINT_VISIBLE = 4
const FORMAT_V1 = 1
const HEADER_BYTES = 4
const IV_BYTES = 12
const TAG_BYTES = 16
