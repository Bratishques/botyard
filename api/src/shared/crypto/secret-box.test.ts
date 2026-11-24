import { describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { LocalKeyEncryptionKey } from './key-encryption-key'
import { SecretBox, SecretBoxError, secretHint } from './secret-box'

const kek = (id: number) => new LocalKeyEncryptionKey(id, randomBytes(32))
const context = 'destination:0193f0a2-0000-7000-8000-000000000001:api_key'
const secret = 'dokploy_api_key_example_value'

describe('SecretBox', () => {
  test('открывает то, что запечатал', async () => {
    const box = new SecretBox([kek(1)])

    expect(await box.open(await box.seal(secret, context), context)).toBe(secret)
  })

  test('не кладёт секрет открытым текстом и каждый раз даёт новый конверт', async () => {
    const box = new SecretBox([kek(1)])
    const first = await box.seal(secret, context)
    const second = await box.seal(secret, context)

    expect(Buffer.from(first).includes(Buffer.from(secret))).toBe(false)
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(false)
  })

  test('конверт другой записи не открывается: AAD привязывает его к контексту', async () => {
    const box = new SecretBox([kek(1)])
    const sealed = await box.seal(secret, context)

    await expect(box.open(sealed, 'destination:other:api_key')).rejects.toThrow(SecretBoxError)
  })

  test('испорченный байт шифртекста не открывается', async () => {
    const box = new SecretBox([kek(1)])
    const sealed = Buffer.from(await box.seal(secret, context))
    sealed[sealed.length - 1] = (sealed[sealed.length - 1] ?? 0) ^ 0x01

    await expect(box.open(sealed, context)).rejects.toThrow('envelope cannot be opened')
  })

  test('чужой мастер-ключ с тем же id не открывает', async () => {
    const sealed = await new SecretBox([kek(1)]).seal(secret, context)

    await expect(new SecretBox([kek(1)]).open(sealed, context)).rejects.toThrow('envelope cannot be opened')
  })

  test('после ротации старые секреты читаются прежним ключом, новые пишутся текущим', async () => {
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

describe('secretHint', () => {
  test('показывает только хвост длинного секрета', () => {
    expect(secretHint('abcdefghijklmnop')).toBe('••••mnop')
  })

  test('короткий секрет не раскрывает вовсе', () => {
    expect(secretHint('abcd1234')).toBe('••••')
  })
})
