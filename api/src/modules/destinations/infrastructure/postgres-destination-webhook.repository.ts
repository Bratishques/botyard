import { Injectable } from '@nestjs/common'
import { sql } from 'kysely'
import { UnitOfWork } from '../../../shared/database/unit-of-work'
import type { DestinationWebhook, DestinationWebhookRepository } from '../domain/webhook'

@Injectable()
export class PostgresDestinationWebhookRepository implements DestinationWebhookRepository {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  async find(destinationId: string): Promise<DestinationWebhook | null> {
    const row = await this.unitOfWork
      .db()
      .selectFrom('destination_webhook')
      .selectAll()
      .where('destination_id', '=', destinationId)
      .executeTakeFirst()

    return row ? toWebhook(row) : null
  }

  async ensure(destinationId: string, secretSealed: Uint8Array): Promise<DestinationWebhook> {
    // ON CONFLICT DO NOTHING + чтение: из двух одновременных регистраций секрет остаётся один
    await this.unitOfWork
      .db()
      .insertInto('destination_webhook')
      .values({ destination_id: destinationId, secret_sealed: secretSealed })
      .onConflict((conflict) => conflict.column('destination_id').doNothing())
      .execute()
    const row = await this.unitOfWork
      .db()
      .selectFrom('destination_webhook')
      .selectAll()
      .where('destination_id', '=', destinationId)
      .executeTakeFirstOrThrow()

    return toWebhook(row)
  }

  async recordRegistered(destinationId: string, baseUrl: string, notificationId: string, endpoint: string): Promise<boolean> {
    const result = await this.unitOfWork
      .db()
      .updateTable('destination_webhook')
      .set({ notification_id: notificationId, endpoint, error: null, registered_at: sql<Date>`now()`, updated_at: sql<Date>`now()` })
      .where('destination_id', '=', destinationId)
      .where(({ exists, selectFrom }) =>
        exists(selectFrom('destination').select('id').where('id', '=', destinationId).where('base_url', '=', baseUrl)),
      )
      .executeTakeFirst()

    return Number(result.numUpdatedRows) > 0
  }

  async recordFailed(destinationId: string, error: string): Promise<void> {
    await this.unitOfWork
      .db()
      .updateTable('destination_webhook')
      .set({ error, updated_at: sql<Date>`now()` })
      .where('destination_id', '=', destinationId)
      .execute()
  }
}

function toWebhook(row: {
  destination_id: string
  secret_sealed: Uint8Array
  notification_id: string | null
  endpoint: string | null
  error: string | null
  registered_at: Date | null
}): DestinationWebhook {
  return {
    destinationId: row.destination_id,
    secretSealed: row.secret_sealed,
    notificationId: row.notification_id,
    endpoint: row.endpoint,
    error: row.error,
    registeredAt: row.registered_at,
  }
}
