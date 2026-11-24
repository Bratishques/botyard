import { Global, Injectable, Module } from '@nestjs/common'
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

  async enqueue(topic: OutboxTopic, payload: Record<string, unknown>): Promise<string> {
    const id = Bun.randomUUIDv7()
    await this.unitOfWork
      .db()
      .insertInto('outbox_message')
      .values({ id, topic, payload: JSON.stringify(payload) })
      .execute()

    return id
  }
}

@Global()
@Module({ providers: [Outbox], exports: [Outbox] })
export class OutboxModule {}
