import { createHash } from 'node:crypto'
import { Global, Injectable, Module } from '@nestjs/common'
import { sql } from 'kysely'
import { UnitOfWork } from '../database/unit-of-work'
import { canonicalJson } from '../json/canonical-json'

/** Формат ключа — из контракта API: один источник для api и админки */
export { IDEMPOTENCY_KEY } from '@botyard/contract'

/**
 * Сколько ключ помнится как минимум: повтор после обрыва приходит за секунды, сутки — с большим запасом.
 * Удаляет его reconciler, поэтому без этого процесса ключ живёт дольше
 */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000

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
 * Записи живут не меньше `IDEMPOTENCY_TTL_MS` (сутки): старше — удаляет reconciler, и тот же ключ дальше — новый запрос.
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
      // Вставка не прошла, а строки нет — её только что удалила очистка (ключ старше суток). Тогда это новый
      // запрос: вставить ещё раз. Второй раз так не совпадёт — свежий ключ очистка не трогает
      for (let round = 0; ; round++) {
        const claimed = await this.unitOfWork
          .db()
          .insertInto('idempotency_record')
          .values({ scope, key, request_hash: requestHash, status_code: 0, response: 'null' })
          .onConflict((conflict) => conflict.columns(['scope', 'key']).doNothing())
          .returning('key')
          .executeTakeFirst()
        if (claimed) break

        const stored = await this.unitOfWork
          .db()
          .selectFrom('idempotency_record')
          .select(['request_hash', 'status_code', 'response'])
          .where('scope', '=', scope)
          .where('key', '=', key)
          .executeTakeFirst()
        if (!stored && round === 0) continue
        if (!stored) throw new Error(`idempotency key ${scope}/${key} vanished twice`)
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

  /**
   * Удалить ключи старше `olderThanMs`, не больше `limit` за раз. По `ctid`: выборка идёт по индексу
   * `created_at`, удаление — точечно по найденным строкам (через `(scope, key) IN (…)` Postgres сканировал всю
   * таблицу на каждую порцию). Возвращает число удалённых
   */
  async purgeExpired(olderThanMs: number, limit: number): Promise<number> {
    const result = await sql`
      DELETE FROM idempotency_record WHERE ctid = ANY(ARRAY(
        SELECT ctid FROM idempotency_record
        WHERE created_at < now() - make_interval(secs => ${olderThanMs / 1000})
        LIMIT ${limit}
      ))
    `.execute(this.unitOfWork.db())

    return Number(result.numAffectedRows ?? 0)
  }
}

@Global()
@Module({ providers: [Idempotency], exports: [Idempotency] })
export class IdempotencyModule {}
