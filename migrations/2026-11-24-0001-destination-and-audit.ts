import { type Kysely, sql } from 'kysely'

/**
 * Назначения и журнал аудита.
 *
 * Ключ Dokploy хранится конвертом: `api_key_sealed` — версия формата, обёрнутый ключ данных
 * и шифртекст (см. shared/crypto). Открытым текстом в базе он не появляется никогда, а
 * `api_key_hint` — последние символы, чтобы оператор узнал ключ в списке.
 *
 * Ограничения дублируют проверки домена намеренно: строка, записанная в обход сценария
 * (руками, будущей миграцией, ошибкой в репозитории), не должна ломать инварианты.
 *
 * Миграции только вперёд, поэтому `down` нет.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE destination (
      id              uuid PRIMARY KEY,
      name            text NOT NULL CHECK (name = btrim(name) AND length(name) BETWEEN 1 AND 80),
      -- Нормализованный адрес: схема и хост в нижнем регистре, без косой черты в конце
      base_url        text NOT NULL CHECK (base_url ~ '^https?://[a-z0-9.-]+(:[0-9]+)?(/[^?#]*[^/?#])?$'),
      api_key_sealed  bytea NOT NULL CHECK (octet_length(api_key_sealed) > 0),
      api_key_hint    text NOT NULL CHECK (length(api_key_hint) > 0),
      project_id      text NOT NULL CHECK (length(project_id) > 0),
      environment_id  text NOT NULL CHECK (length(environment_id) > 0),
      server_id       text CHECK (server_id IS NULL OR length(server_id) > 0),
      status          text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'UNREACHABLE', 'DISABLED')),
      last_checked_at timestamptz,
      last_error      text,
      version         integer NOT NULL DEFAULT 1 CHECK (version > 0),
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
      actor       text NOT NULL CHECK (length(actor) > 0),
      action      text NOT NULL CHECK (length(action) > 0),
      target_type text NOT NULL CHECK (length(target_type) > 0),
      target_id   text,
      payload     jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
      created_at  timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db)
  await sql`CREATE INDEX audit_event_target_idx ON audit_event (target_type, target_id, created_at DESC)`.execute(db)

  /*
   * Аудит, который можно поправить, ничего не доказывает: запрет на уровне базы, а не только в коде.
   * Ограничение: владелец таблицы может отключить триггер. Полная гарантия — отдельная роль для
   * миграций и роль приложения без владения таблицами (см. docs/roadmap.md).
   */
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
  await sql`
    CREATE TRIGGER audit_event_no_truncate BEFORE TRUNCATE ON audit_event
    FOR EACH STATEMENT EXECUTE FUNCTION audit_event_append_only()
  `.execute(db)
}
