import { describe, expect, test } from 'bun:test'
import { sql } from 'kysely'
import { UnitOfWork } from '../../src/shared/database/unit-of-work'
import { Housekeeping } from '../../src/shared/housekeeping/housekeeping'
import { Idempotency } from '../../src/shared/idempotency/idempotency'
import { WebhookInbox } from '../../src/shared/inbox/inbox'
import { Outbox } from '../../src/shared/outbox/outbox'
import { db } from './setup'

const unitOfWork = new UnitOfWork(db)
const housekeeping = new Housekeeping(new Outbox(unitOfWork), new Idempotency(unitOfWork), new WebhookInbox(unitOfWork))

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

describe('ключ идемпотентности и очистка', () => {
  test('ключ удалён очисткой между конфликтной вставкой и чтением — это новый запрос, работа выполняется один раз', async () => {
    const stale = await key(25)
    let armed = true
    let works = 0
    /** Перехват: перед чтением сохранённого ответа ключ удаляет «очистка» и коммитит — окно из ревью */
    const racing = new (class extends UnitOfWork {
      override db() {
        const real = super.db()
        return new Proxy(real, {
          get(target, property, receiver) {
            const value = Reflect.get(target, property, receiver)
            if (typeof value !== 'function') return value
            // Методы Kysely работают с приватными полями: вызывать их на исходном объекте, а не на прокси
            if (property !== 'selectFrom' || !armed) return value.bind(target)
            return (...args: unknown[]) => wrap(value.apply(target, args))
          },
        })
      }
    })(db)
    function wrap<T extends object>(builder: T): T {
      return new Proxy(builder, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver)
          if (typeof value !== 'function') return value
          if (property === 'executeTakeFirst') {
            return async (...args: unknown[]) => {
              armed = false
              await sql`DELETE FROM idempotency_record WHERE key = ${stale}`.execute(db)
              return value.apply(target, args)
            }
          }
          return (...args: unknown[]) => {
            const next = value.apply(target, args)
            return typeof next === 'object' && next !== null ? wrap(next) : next
          }
        },
      })
    }
    const result = await new Idempotency(racing).run('test', stale, { any: 'request' }, async () => {
      works++
      return { statusCode: 201, response: { fresh: true } }
    })

    expect(result).toEqual({ statusCode: 201, response: { fresh: true }, replayed: false })
    expect(works).toBe(1)
  })
})

describe('действия после коммита', () => {
  test('внутри вложенной транзакции — только после коммита внешней; при откате — никогда', async () => {
    const seen: string[] = []
    const visibleAtSignal: number[] = []
    const id = Bun.randomUUIDv7()

    await unitOfWork.run(async () => {
      await unitOfWork.run(async () => {
        await sql`INSERT INTO outbox_message (id, topic, payload) VALUES (${id}, 'operation.step', '{}')`.execute(unitOfWork.db())
        unitOfWork.afterCommit(() => seen.push('committed'))
      })
      expect(seen).toEqual([]) // внутренний run закончился, но коммита ещё нет
      unitOfWork.afterCommit(() => {
        // Сигнал уходит, когда запись уже видна другим соединениям
        void db
          .selectFrom('outbox_message')
          .select('id')
          .where('id', '=', id)
          .execute()
          .then((rows) => visibleAtSignal.push(rows.length))
      })
    })
    expect(seen).toEqual(['committed'])
    await Bun.sleep(50)
    expect(visibleAtSignal).toEqual([1])

    await expect(
      unitOfWork.run(async () => {
        unitOfWork.afterCommit(() => seen.push('rolled back'))
        throw new Error('rollback')
      }),
    ).rejects.toThrow('rollback')
    expect(seen).toEqual(['committed'])
  })
})
