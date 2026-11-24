import { Global, Injectable, Module } from '@nestjs/common'
import { sql } from 'kysely'
import { UnitOfWork } from '../database/unit-of-work'

/**
 * Inbox входящих событий (вебхуки Dokploy): одно событие — одна обработка. Ключ дедупликации — хеш полей
 * события (Dokploy своего id не даёт). Принятие — вставка ON CONFLICT DO NOTHING в той же транзакции, что и
 * реакция на событие: повтор при обрыве ответа или дубль от Dokploy ничего не делает.
 */
@Injectable()
export class WebhookInbox {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  /** `true` — событие новое и принято; `false` — такое уже было */
  async accept(event: { dedupKey: string; destinationId: string; applicationName: string; status: string }): Promise<boolean> {
    const inserted = await this.unitOfWork
      .db()
      .insertInto('webhook_inbox')
      .values({
        dedup_key: event.dedupKey,
        destination_id: event.destinationId,
        application_name: event.applicationName,
        status: event.status,
      })
      .onConflict((conflict) => conflict.column('dedup_key').doNothing())
      .returning('dedup_key')
      .executeTakeFirst()

    return inserted !== undefined
  }

  /** Удалить события старше `olderThanMs`, не больше `limit` за раз */
  async purge(olderThanMs: number, limit: number): Promise<number> {
    const result = await sql`
      DELETE FROM webhook_inbox WHERE dedup_key IN (
        SELECT dedup_key FROM webhook_inbox WHERE received_at < now() - make_interval(secs => ${olderThanMs / 1000}) LIMIT ${limit}
      )
    `.execute(this.unitOfWork.db())

    return Number(result.numAffectedRows ?? 0)
  }
}

@Global()
@Module({ providers: [WebhookInbox], exports: [WebhookInbox] })
export class InboxModule {}
