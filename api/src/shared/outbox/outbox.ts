import { Global, Injectable, Module } from '@nestjs/common'
import { sql } from 'kysely'
import { UnitOfWork } from '../database/unit-of-work'

/** Темы outbox. Сообщение — команда или событие; полезная нагрузка без секретов */
export const OutboxTopic = {
  /** Выполнить следующий шаг операции над развёртыванием (воркер саги) */
  OPERATION_STEP: 'operation.step',
} as const
export type OutboxTopic = (typeof OutboxTopic)[keyof typeof OutboxTopic]

/**
 * Transactional outbox: сообщение пишется в той же транзакции, что и изменение, которое его вызвало, —
 * команда не теряется, если процесс упадёт между коммитом и отправкой в брокер, и не уходит, если
 * транзакция откатилась. Публикует relay (`PROCESS_ROLE=relay`), доставка «хотя бы один раз».
 */
@Injectable()
export class Outbox {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  /** `delayMs` — опубликовать не раньше чем через столько: повтор шага с паузой, опрос идущего деплоя */
  async enqueue(topic: OutboxTopic, payload: Record<string, unknown>, options: { delayMs?: number } = {}): Promise<string> {
    const id = Bun.randomUUIDv7()
    const delayMs = Math.max(0, Math.round(options.delayMs ?? 0))
    await this.unitOfWork
      .db()
      .insertInto('outbox_message')
      .values({
        id,
        topic,
        payload: JSON.stringify(payload),
        // Время базы, а не процесса: relay сравнивает с now() базы, и часы воркера тут не участвуют
        ...(delayMs > 0 && { available_at: sql<Date>`now() + make_interval(secs => ${delayMs / 1000})` }),
      })
      .execute()

    return id
  }

  /**
   * Удалить опубликованные сообщения старше `olderThanMs`, не больше `limit` за раз: порция короткая и не держит
   * блокировок. Неопубликованные не трогаются никогда. Возвращает число удалённых
   */
  async purgePublished(olderThanMs: number, limit: number): Promise<number> {
    const result = await sql`
      DELETE FROM outbox_message WHERE id IN (
        SELECT id FROM outbox_message
        WHERE published_at IS NOT NULL AND published_at < now() - make_interval(secs => ${olderThanMs / 1000})
        LIMIT ${limit}
      )
    `.execute(this.unitOfWork.db())

    return Number(result.numAffectedRows ?? 0)
  }
}

@Global()
@Module({ providers: [Outbox], exports: [Outbox] })
export class OutboxModule {}
