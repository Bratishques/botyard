import { type Kysely, sql } from 'kysely'

/**
 * Назначения и журнал аудита.
 *
 * Ключ Dokploy хранится конвертом: `api_key_sealed` — версия формата, зашифрованный ключ данных
 * и шифртекст (см. shared/crypto). Открытым текстом в базе он не появляется никогда, а
 * `api_key_hint` — последние символы, чтобы оператор узнал ключ в списке.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE destination (
      id              uuid PRIMARY KEY,
      name            text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
      base_url        text NOT NULL CHECK (base_url ~ '^https?://'),
      api_key_sealed  bytea NOT NULL,
      api_key_hint    text NOT NULL,
      project_id      text NOT NULL,
      environment_id  text NOT NULL,
      server_id       text,
      status          text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'UNREACHABLE', 'DISABLED')),
      last_checked_at timestamptz,
      last_error      text,
      version         integer NOT NULL DEFAULT 1,
      created_at      timestamptz NOT NULL DEFAULT now(),
      updated_at      timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db)

  // Имя — то, по чему оператор выбирает назначение: регистр не должен давать двойников
  await sql`CREATE UNIQUE INDEX destination_name_uq ON destination (lower(name))`.execute(db)
  // Одно и то же окружение Dokploy (и сервер в нём) дважды не заводится
  await sql`
    CREATE UNIQUE INDEX destination_target_uq ON destination (base_url, environment_id, coalesce(server_id, ''))
  `.execute(db)

  await sql`
    CREATE TABLE audit_event (
      id          uuid PRIMARY KEY,
      actor       text NOT NULL,
      action      text NOT NULL,
      target_type text NOT NULL,
      target_id   text,
      payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at  timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db)
  await sql`CREATE INDEX audit_event_target_idx ON audit_event (target_type, target_id, created_at DESC)`.execute(db)

  // Аудит, который можно поправить, ничего не доказывает: запрет на уровне базы, а не только в коде
  await sql`
    CREATE FUNCTION audit_event_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'audit_event is append-only' USING ERRCODE = 'insufficient_privilege';
    END
    $$
  `.execute(db)
  await sql`
    CREATE TRIGGER audit_event_append_only BEFORE UPDATE OR DELETE ON audit_event
    FOR EACH ROW EXECUTE FUNCTION audit_event_append_only()
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE audit_event`.execute(db)
  await sql`DROP FUNCTION audit_event_append_only()`.execute(db)
  await sql`DROP TABLE destination`.execute(db)
}
