import { type Kysely, sql } from 'kysely'

/**
 * Развёртывания, операции над ними, outbox и записи идемпотентности.
 *
 * - `bot_deployment` ссылается на конкретную версию шаблона (составной FK): правка каталога не меняет
 *   запущенного робота. `app_name` — детерминированное имя приложения в Dokploy, ключ поиска перед созданием.
 * - `trading_mode` закрепляет режим клиента (песочница или боевой) на момент создания: смена режима клиента
 *   не превращает песочного робота в боевого при следующем redeploy.
 * - У развёртывания не больше одной активной операции (`active_operation_id`); захват — условной записью.
 * - `outbox_message` пишется в одной транзакции с изменением; relay публикует его в RabbitMQ.
 * - `idempotency_record` хранит ответ на запрос с `Idempotency-Key` — повтор получает тот же ответ.
 *   Очистки старых записей и опубликованных сообщений пока нет (docs/roadmap.md), индексы под неё есть.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE bot_deployment (
      id                  uuid PRIMARY KEY,
      customer_id         uuid NOT NULL REFERENCES customer (id),
      destination_id      uuid NOT NULL REFERENCES destination (id),
      template_id         text NOT NULL,
      template_version    text NOT NULL,
      config              jsonb NOT NULL CHECK (jsonb_typeof(config) = 'object'),
      trading_mode        text NOT NULL CHECK (trading_mode IN ('sandbox', 'live')),
      app_name            text NOT NULL UNIQUE CHECK (app_name ~ '^by-[0-9a-f]{12}$'),
      status              text NOT NULL CHECK (status IN ('PROVISIONING', 'RUNNING', 'STOPPED', 'FAILED', 'DELETING', 'DELETED')),
      dokploy_app_id      text CHECK (dokploy_app_id IS NULL OR dokploy_app_id !~ '^[[:space:]]*$'),
      active_operation_id uuid,
      last_error          text,
      version             integer NOT NULL DEFAULT 1 CHECK (version > 0),
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY (template_id, template_version) REFERENCES bot_template_version (template_id, version),
      CHECK (status <> 'DELETED' OR active_operation_id IS NULL)
    )
  `.execute(db)
  await sql`CREATE INDEX bot_deployment_customer_idx ON bot_deployment (customer_id) WHERE status <> 'DELETED'`.execute(db)
  await sql`CREATE INDEX bot_deployment_destination_idx ON bot_deployment (destination_id)`.execute(db)
  await sql`CREATE INDEX bot_deployment_template_idx ON bot_deployment (template_id, template_version)`.execute(db)

  await sql`
    CREATE TABLE operation (
      id            uuid PRIMARY KEY,
      deployment_id uuid NOT NULL REFERENCES bot_deployment (id),
      kind          text NOT NULL CHECK (kind IN ('PROVISION', 'START', 'STOP', 'REDEPLOY', 'DELETE')),
      status        text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED')),
      step          text,
      attempt       integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
      error         text,
      requested_by  text NOT NULL CHECK (requested_by !~ '^[[:space:]]*$'),
      created_at    timestamptz NOT NULL DEFAULT now(),
      updated_at    timestamptz NOT NULL DEFAULT now(),
      finished_at   timestamptz,
      CHECK ((status IN ('SUCCEEDED', 'FAILED')) = (finished_at IS NOT NULL)),
      UNIQUE (id, deployment_id)
    )
  `.execute(db)
  await sql`CREATE INDEX operation_deployment_idx ON operation (deployment_id, created_at DESC)`.execute(db)

  // Активная операция — своя операция этого развёртывания (составной ключ); ссылка взаимная, проверка отложена
  await sql`
    ALTER TABLE bot_deployment ADD CONSTRAINT bot_deployment_active_operation_fk
      FOREIGN KEY (active_operation_id, id) REFERENCES operation (id, deployment_id) DEFERRABLE INITIALLY DEFERRED
  `.execute(db)

  await sql`
    CREATE TABLE outbox_message (
      id           uuid PRIMARY KEY,
      topic        text NOT NULL CHECK (topic ~ '^[a-z][a-z_.]{0,62}$'),
      payload      jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
      created_at   timestamptz NOT NULL DEFAULT now(),
      published_at timestamptz
    )
  `.execute(db)
  await sql`CREATE INDEX outbox_unpublished_idx ON outbox_message (id) WHERE published_at IS NULL`.execute(db)
  await sql`CREATE INDEX outbox_published_idx ON outbox_message (published_at) WHERE published_at IS NOT NULL`.execute(db)

  await sql`
    CREATE TABLE idempotency_record (
      scope        text NOT NULL CHECK (scope !~ '^[[:space:]]*$'),
      key          text NOT NULL CHECK (length(key) BETWEEN 8 AND 128),
      request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
      status_code  integer NOT NULL CHECK (status_code = 0 OR status_code BETWEEN 100 AND 599),
      response     jsonb NOT NULL,
      created_at   timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (scope, key)
    )
  `.execute(db)
  await sql`CREATE INDEX idempotency_created_idx ON idempotency_record (created_at)`.execute(db)
}
