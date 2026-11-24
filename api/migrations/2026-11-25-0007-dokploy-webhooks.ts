import { type Kysely, sql } from 'kysely'

/**
 * Вебхуки Dokploy (custom-уведомление о сборке).
 *
 * - `destination_webhook` — регистрация уведомления на назначении: секрет заголовка (конверт, контекст с
 *   `base_url`), id уведомления в Dokploy, итог последней попытки. Отдельно от `destination`: регистрация —
 *   служебная запись и не должна менять версию назначения, по которой оператор правит его.
 * - `webhook_inbox` — принятые события для дедупликации: Dokploy не даёт id события, ключ — хеш назначения,
 *   приложения, статуса и момента сборки. Чистится по возрасту.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE destination_webhook (
      destination_id   uuid PRIMARY KEY REFERENCES destination (id),
      secret_sealed    bytea NOT NULL,
      notification_id  text CHECK (notification_id IS NULL OR notification_id !~ '^[[:space:]]*$'),
      endpoint         text,
      error            text,
      registered_at    timestamptz,
      updated_at       timestamptz NOT NULL DEFAULT now(),
      CHECK ((notification_id IS NULL) = (registered_at IS NULL))
    )
  `.execute(db)

  await sql`
    CREATE TABLE webhook_inbox (
      dedup_key        text PRIMARY KEY CHECK (dedup_key ~ '^[0-9a-f]{64}$'),
      destination_id   uuid NOT NULL REFERENCES destination (id),
      application_name text NOT NULL,
      status           text NOT NULL,
      received_at      timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db)
  await sql`CREATE INDEX webhook_inbox_received_idx ON webhook_inbox (received_at)`.execute(db)
}
