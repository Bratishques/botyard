import { describe, expect, test } from 'bun:test'
import { sql } from 'kysely'
import { migrateToLatest } from '../../src/shared/database/migrate'
import { db } from './setup'

const destination = (overrides: Record<string, unknown> = {}) => ({
  id: Bun.randomUUIDv7(),
  name: `dest-${crypto.randomUUID().slice(0, 8)}`,
  base_url: `https://dokploy-${crypto.randomUUID().slice(0, 8)}.example.com`,
  api_key_sealed: new Uint8Array([1, 2, 3]),
  api_key_hint: '••••abcd',
  project_id: 'p1',
  environment_id: 'e1',
  server_id: null,
  ...overrides,
})

/** Код ошибки Postgres: 23505 — уникальность, 23514 — CHECK, 42501 — запрет триггера */
async function pgCode(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run()
    return undefined
  } catch (error) {
    return (error as { code?: string }).code
  }
}

describe('миграции', () => {
  test('повторный прогон ничего не применяет', async () => {
    const { error, results } = await migrateToLatest(db)

    expect(error).toBeUndefined()
    expect(results).toEqual([])
  })
})

describe('destination', () => {
  test('bytea конверта читается теми же байтами', async () => {
    const row = destination({ api_key_sealed: new Uint8Array([0, 1, 255]) })
    await db.insertInto('destination').values(row).execute()

    const stored = await db
      .selectFrom('destination')
      .select(['api_key_sealed', 'status', 'version'])
      .where('id', '=', row.id)
      .executeTakeFirstOrThrow()

    expect([...stored.api_key_sealed]).toEqual([0, 1, 255])
    expect(stored.status).toBe('ACTIVE')
    expect(stored.version).toBe(1)
  })

  test('имя уникально без учёта регистра', async () => {
    await db
      .insertInto('destination')
      .values(destination({ name: 'Production' }))
      .execute()

    expect(
      await pgCode(() =>
        db
          .insertInto('destination')
          .values(destination({ name: 'production' }))
          .execute(),
      ),
    ).toBe('23505')
  })

  test('одно окружение Dokploy не заводится дважды', async () => {
    const base_url = 'https://twice.example.com'
    await db.insertInto('destination').values(destination({ base_url })).execute()

    expect(await pgCode(() => db.insertInto('destination').values(destination({ base_url })).execute())).toBe('23505')
  })

  test.each([
    ['имя с пробелом по краю', { name: 'prod ' }],
    ['адрес с косой чертой в конце', { base_url: 'https://slash.example.com/' }],
    ['адрес в верхнем регистре', { base_url: 'https://Upper.example.com' }],
    ['пустой конверт', { api_key_sealed: new Uint8Array() }],
    ['пустая подсказка', { api_key_hint: '' }],
    ['пустой проект', { project_id: '' }],
    ['пустое окружение', { environment_id: '' }],
    ['пустой сервер', { server_id: '' }],
    ['неизвестный статус', { status: 'BROKEN' }],
  ])('CHECK не пускает: %s', async (_, overrides) => {
    expect(await pgCode(() => db.insertInto('destination').values(destination(overrides)).execute())).toBe('23514')
  })
})

describe('audit_event', () => {
  const event = () => ({ id: Bun.randomUUIDv7(), actor: 'operator:1', action: 'destination.created', target_type: 'destination' })

  test('payload — только объект', async () => {
    expect(
      await pgCode(() =>
        sql`INSERT INTO audit_event (id, actor, action, target_type, payload) VALUES (${Bun.randomUUIDv7()}, 'a', 'b', 'c', '[1]'::jsonb)`.execute(
          db,
        ),
      ),
    ).toBe('23514')
  })

  test('UPDATE, DELETE и TRUNCATE запрещены', async () => {
    const row = event()
    await db.insertInto('audit_event').values(row).execute()

    expect(await pgCode(() => sql`UPDATE audit_event SET actor = 'x' WHERE id = ${row.id}`.execute(db))).toBe('42501')
    expect(await pgCode(() => sql`DELETE FROM audit_event WHERE id = ${row.id}`.execute(db))).toBe('42501')
    expect(await pgCode(() => sql`TRUNCATE audit_event`.execute(db))).toBe('42501')

    const left = await db.selectFrom('audit_event').select('actor').where('id', '=', row.id).executeTakeFirst()
    expect(left?.actor).toBe('operator:1')
  })
})
