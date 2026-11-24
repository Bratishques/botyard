import { describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { LOCAL_WRAPPED_BYTES, LocalKeyEncryptionKey } from './key-encryption-key'
import { SecretBox, SecretBoxError, secretContext, secretHint } from './secret-box'

const kek = (id: number) => new LocalKeyEncryptionKey(id, randomBytes(32))
const context = secretContext('destination', '0193f0a2-0000-7000-8000-000000000001', 'api_key', 'https://dokploy.example.com')
const secret = 'dokploy_api_key_example_value'

/** Разбор конверта v1 для проверок: заголовок, обёрнутый ключ, iv, тег, шифртекст */
function parse(sealed: Uint8Array) {
  const bytes = Buffer.from(sealed)
  const wrappedEnd = 4 + bytes.readUInt16BE(2)

  return {
    header: bytes.subarray(0, 4),
    wrapped: bytes.subarray(4, wrappedEnd),
    iv: bytes.subarray(wrappedEnd, wrappedEnd + 12),
    rest: bytes.subarray(wrappedEnd + 12),
  }
}

describe('SecretBox', () => {
  test('открывает то, что запечатал, в том числе пустую строку и юникод', async () => {
    const box = new SecretBox([kek(1)])

    expect(await box.open(await box.seal(secret, context), context)).toBe(secret)
    expect(await box.open(await box.seal('', context), context)).toBe('')
    expect(await box.open(await box.seal('ключ 🔑', context), context)).toBe('ключ 🔑')
  })

  test('не кладёт секрет открытым текстом', async () => {
    const sealed = await new SecretBox([kek(1)]).seal(secret, context)

    expect(Buffer.from(sealed).includes(Buffer.from(secret))).toBe(false)
  })

  test('каждая запечатка — свой ключ данных и свой iv: nonce в GCM не повторяется', async () => {
    const key = kek(1)
    const box = new SecretBox([key])
    const first = parse(await box.seal(secret, context))
    const second = parse(await box.seal(secret, context))
    const aad = first.header.subarray(0, 2)

    expect(first.iv.equals(second.iv)).toBe(false)
    // iv обёртки под долгоживущим мастер-ключом тоже не повторяется
    expect(first.wrapped.subarray(0, 12).equals(second.wrapped.subarray(0, 12))).toBe(false)
    expect(Buffer.from(await key.unwrap(first.wrapped, aad)).equals(Buffer.from(await key.unwrap(second.wrapped, aad)))).toBe(false)
  })

  test('конверт другой записи или другого адреса не открывается', async () => {
    const box = new SecretBox([kek(1)])
    const sealed = await box.seal(secret, context)
    const otherRow = secretContext('destination', '0193f0a2-0000-7000-8000-000000000002', 'api_key', 'https://dokploy.example.com')
    const otherHost = secretContext('destination', '0193f0a2-0000-7000-8000-000000000001', 'api_key', 'https://evil.example.com')

    await expect(box.open(sealed, otherRow)).rejects.toThrow(SecretBoxError)
    await expect(box.open(sealed, otherHost)).rejects.toThrow('envelope cannot be opened')
  })

  test('обёрнутый ключ данных из другого конверта не подходит', async () => {
    const box = new SecretBox([kek(1)])
    const a = parse(await box.seal(secret, context))
    const b = parse(await box.seal('other secret', context))
    const swapped = Buffer.concat([a.header, b.wrapped, a.iv, a.rest])

    await expect(box.open(swapped, context)).rejects.toThrow('envelope cannot be opened')
  })

  test('KEK проверяет свой тег: испорченная обёртка не разворачивается', async () => {
    const key = kek(1)
    const { header, wrapped } = parse(await new SecretBox([key]).seal(secret, context))
    const broken = Buffer.from(wrapped)
    broken[20] = (broken[20] ?? 0) ^ 0x01

    await expect(key.unwrap(broken, header.subarray(0, 2))).rejects.toThrow()
    await expect(key.unwrap(wrapped, Buffer.from([1, 9]))).rejects.toThrow()
    expect(wrapped.length).toBe(LOCAL_WRAPPED_BYTES)
    for (const length of [28, LOCAL_WRAPPED_BYTES - 1, LOCAL_WRAPPED_BYTES + 1]) {
      await expect(key.unwrap(Buffer.concat([wrapped, Buffer.alloc(1)]).subarray(0, length), header.subarray(0, 2))).rejects.toThrow(
        'wrapped data key has wrong length',
      )
    }
  })

  test('испорченный байт в любом месте конверта — отказ', async () => {
    const box = new SecretBox([kek(1)])
    const sealed = Buffer.from(await box.seal(secret, context))

    for (const position of [2, 3, 10, 40, 70, 80, sealed.length - 1]) {
      const broken = Buffer.from(sealed)
      broken[position] = (broken[position] ?? 0) ^ 0x01
      await expect(box.open(broken, context)).rejects.toThrow(SecretBoxError)
    }
  })

  test('обрезанный конверт и неверная длина обёртки — отказ без падения', async () => {
    const box = new SecretBox([kek(1)])
    const sealed = Buffer.from(await box.seal(secret, context))
    const wrappedEnd = 4 + LOCAL_WRAPPED_BYTES

    for (const length of [0, 1, 3, 4, 5, wrappedEnd, wrappedEnd + 27, wrappedEnd + 28]) {
      await expect(box.open(sealed.subarray(0, length), context)).rejects.toThrow(SecretBoxError)
    }
    for (const declared of [0, 1, 59, 61, 65535]) {
      const forged = Buffer.from(sealed)
      forged.writeUInt16BE(declared, 2)
      await expect(box.open(forged, context)).rejects.toThrow(SecretBoxError)
    }
  })

  test('чужой мастер-ключ с тем же id не открывает', async () => {
    const sealed = await new SecretBox([kek(1)]).seal(secret, context)

    await expect(new SecretBox([kek(1)]).open(sealed, context)).rejects.toThrow('envelope cannot be opened')
  })

  test('второй ключ читает старые конверты, новые пишутся первым', async () => {
    const old = kek(1)
    const sealedBefore = await new SecretBox([old]).seal(secret, context)
    const rotated = new SecretBox([kek(2), old])
    const sealedAfter = await rotated.seal(secret, context)

    expect(await rotated.open(sealedBefore, context)).toBe(secret)
    expect(sealedAfter[1]).toBe(2)
  })

  test('конверт с незнакомым ключом или форматом отклоняется с понятной причиной', async () => {
    const sealed = Buffer.from(await new SecretBox([kek(3)]).seal(secret, context))

    await expect(new SecretBox([kek(1)]).open(sealed, context)).rejects.toThrow('master key 3 is not configured')
    sealed[0] = 2
    await expect(new SecretBox([kek(3)]).open(sealed, context)).rejects.toThrow('unsupported envelope format')
  })

  test('не принимает мастер-ключ не той длины и повтор id', () => {
    expect(() => new LocalKeyEncryptionKey(1, randomBytes(16))).toThrow('must be 32 bytes')
    expect(() => new SecretBox([kek(1), kek(1)])).toThrow('unique')
  })
})

describe('secretContext', () => {
  test('не даёт пустую или произвольную часть', () => {
    expect(() => secretContext('destination', '', 'api_key')).toThrow('invalid secret context part')
    expect(() => secretContext('destination', 'id with space', 'api_key')).toThrow('invalid secret context part')
    expect(() => secretContext('destination', 'a|b', 'api_key')).toThrow('invalid secret context part')
  })
})

describe('secretHint', () => {
  test('показывает только хвост длинного секрета', () => {
    expect(secretHint('abcdefghijklmnop')).toBe('••••mnop')
  })

  test('короткий секрет не раскрывает вовсе', () => {
    expect(secretHint('')).toBe('••••')
    expect(secretHint('abcdefghi')).toBe('••••')
    expect(secretHint('abcdefghijklmno')).toBe('••••')
  })
})
