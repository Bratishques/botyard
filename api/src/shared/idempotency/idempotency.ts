import { createHash } from 'node:crypto'
import { Global, Injectable, Module } from '@nestjs/common'
import { UnitOfWork } from '../database/unit-of-work'
import { canonicalJson } from '../json/canonical-json'

export const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,128}$/

/** Коды ответа API про сам ключ, а не про действие */
export const IdempotencyErrorCode = {
  KEY_REQUIRED: 'IDEMPOTENCY_KEY_REQUIRED',
  CONFLICT: 'IDEMPOTENCY_CONFLICT',
} as const

export class IdempotencyConflictError extends Error {
  override readonly name = 'IdempotencyConflictError'
}

export interface IdempotentResult {
  readonly statusCode: number
  /** Ответ как он ушёл клиенту в первый раз (для повтора — прочитан из базы) */
  readonly response: unknown
  /** Ответ сохранён ранее: работа этим вызовом не выполнялась */
  readonly replayed: boolean
}

/**
 * Идемпотентность изменяющих запросов (`Idempotency-Key`). Работа таких запросов — только запись в базу,
 * поэтому запись ключа, работа и сохранение ответа — одна транзакция:
 *
 * - первый запрос вставляет ключ и выполняет работу; ошибка откатывает всё — ключ не «сгорает»;
 * - повтор во время первого ждёт на уникальном ключе, пока первый не закоммитит, и получает его ответ;
 * - повтор с тем же ключом, но другим телом — `IdempotencyConflictError` (409): это другой запрос.
 *
 * `scope` разделяет ключи операторов и действий: один ключ у двух операторов — два разных запроса.
 *
 * Сохраняется только успешный ответ: ошибка откатывает транзакцию вместе с ключом, и повтор с тем же
 * ключом выполняется заново (например, 409 «идёт другая операция» после её завершения станет 202).
 * Записи пока не удаляются: очистка по `created_at` — в docs/roadmap.md.
 */
@Injectable()
export class Idempotency {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  run(
    scope: string,
    key: string,
    request: unknown,
    work: () => Promise<{ statusCode: number; response: unknown }>,
  ): Promise<IdempotentResult> {
    const requestHash = createHash('sha256').update(canonicalJson(request)).digest('hex')

    return this.unitOfWork.run(async () => {
      const claimed = await this.unitOfWork
        .db()
        .insertInto('idempotency_record')
        .values({ scope, key, request_hash: requestHash, status_code: 0, response: 'null' })
        .onConflict((conflict) => conflict.columns(['scope', 'key']).doNothing())
        .returning('key')
        .executeTakeFirst()

      if (!claimed) {
        const stored = await this.unitOfWork
          .db()
          .selectFrom('idempotency_record')
          .select(['request_hash', 'status_code', 'response'])
          .where('scope', '=', scope)
          .where('key', '=', key)
          .executeTakeFirstOrThrow()
        if (stored.request_hash !== requestHash) throw new IdempotencyConflictError('idempotency key was used with a different request')

        return { statusCode: stored.status_code, response: stored.response, replayed: true }
      }

      const result = await work()
      await this.unitOfWork
        .db()
        .updateTable('idempotency_record')
        .set({ status_code: result.statusCode, response: JSON.stringify(result.response) })
        .where('scope', '=', scope)
        .where('key', '=', key)
        .execute()

      return { ...result, replayed: false }
    })
  }
}

@Global()
@Module({ providers: [Idempotency], exports: [Idempotency] })
export class IdempotencyModule {}
