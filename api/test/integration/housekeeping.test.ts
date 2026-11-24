import { describe, expect, test } from 'bun:test'
import { sql } from 'kysely'
import { UnitOfWork } from '../../src/shared/database/unit-of-work'
import { Housekeeping } from '../../src/shared/housekeeping/housekeeping'
import { Idempotency } from '../../src/shared/idempotency/idempotency'
import { Outbox } from '../../src/shared/outbox/outbox'
import { db } from './setup'

const unitOfWork = new UnitOfWork(db)
const housekeeping = new Housekeeping(new Outbox(unitOfWork), new Idempotency(unitOfWork))

async function message(publishedDaysAgo: number | null): Promise<string> {
  const id = Bun.randomUUIDv7()
  await sql`
    INSERT INTO outbox_message (id, topic, payload, published_at)
    VALUES (${id}, 'operation.step', '{}', ${publishedDaysAgo === null ? null : sql`now() - make_interval(days => ${publishedDaysAgo})`})
  `.execute(db)
  if (publishedDaysAgo === null) await sql`UPDATE outbox_message SET created_at = now() - interval '30 days' WHERE id = ${id}`.execute(db)
  return id
}

async function key(hoursAgo: number): Promise<string> {
  const value = `key-${crypto.randomUUID()}`
  await sql`
    INSERT INTO idempotency_record (scope, key, request_hash, status_code, response, created_at)
    VALUES ('test', ${value}, ${'a'.repeat(64)}, 201, '{}', now() - make_interval(hours => ${hoursAgo}))
  `.execute(db)
  return value
}

describe('очистка служебных таблиц', () => {
  test('опубликованный outbox старше недели и ключи старше суток удаляются; неопубликованное и свежее — нет', async () => {
    const old = await message(8)
    const recent = await message(1)
    const unpublished = await message(null)
    const stale = await key(25)
    const live = await key(1)

    await housekeeping.tick()

    const messages = await db.selectFrom('outbox_message').select('id').where('id', 'in', [old, recent, unpublished]).execute()
    expect(messages.map((row) => row.id).sort()).toEqual([recent, unpublished].sort())
    const keys = await db.selectFrom('idempotency_record').select('key').where('key', 'in', [stale, live]).execute()
    expect(keys.map((row) => row.key)).toEqual([live])
  })
})
