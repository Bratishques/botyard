import { type Kysely, sql } from 'kysely'

/**
 * Клиенты и каталог роботов.
 *
 * Токен T-Invest — только конвертом; контекст конверта привязан к режиму (песочница или боевой счёт),
 * поэтому переход в боевой режим требует ввести боевой токен заново (docs/architecture.md, «Безопасность»).
 *
 * Шаблон робота версионируется: `bot_template_version` неизменна (UPDATE и DELETE запрещены триггером), её
 * ключ — хеш манифеста и файлов. Развёртывание ссылается на конкретную версию — правка каталога не меняет уже
 * запущенных роботов. TRUNCATE версий триггер не запрещает; на шаге 2 его закроют внешние ключи развёртываний.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE customer (
      id                    uuid PRIMARY KEY,
      name                  text NOT NULL CHECK (name !~ '^[[:space:]]|[[:space:]]$' AND length(name) BETWEEN 1 AND 120),
      account_id            text NOT NULL CHECK (account_id ~ '^[A-Za-z0-9_-]{1,64}$'),
      tinvest_token_sealed  bytea NOT NULL CHECK (octet_length(tinvest_token_sealed) > 0),
      tinvest_token_hint    text NOT NULL CHECK (tinvest_token_hint !~ '^[[:space:]]*$'),
      sandbox               boolean NOT NULL DEFAULT true,
      status                text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ARCHIVED')),
      version               integer NOT NULL DEFAULT 1 CHECK (version > 0),
      created_at            timestamptz NOT NULL DEFAULT now(),
      updated_at            timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db)
  await sql`CREATE UNIQUE INDEX customer_name_uq ON customer (lower(name))`.execute(db)

  await sql`
    CREATE TABLE bot_template (
      id              text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9-]{1,38}$'),
      current_version text NOT NULL,
      retired         boolean NOT NULL DEFAULT false,
      updated_at      timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db)

  await sql`
    CREATE TABLE bot_template_version (
      template_id text NOT NULL REFERENCES bot_template (id),
      version     text NOT NULL CHECK (version ~ '^[0-9a-f]{64}$'),
      name        text NOT NULL CHECK (name !~ '^[[:space:]]*$'),
      manifest    jsonb NOT NULL CHECK (jsonb_typeof(manifest) = 'object' AND manifest->>'id' = template_id AND manifest->>'name' = name),
      files       jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(files) = 'object'),
      loaded_at   timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (template_id, version)
    )
  `.execute(db)

  // Версия шаблона неизменна: на неё ссылаются развёртывания, подмена молча изменила бы чужих роботов
  await sql`
    CREATE FUNCTION bot_template_version_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'bot_template_version is immutable' USING ERRCODE = 'insufficient_privilege';
    END
    $$
  `.execute(db)
  await sql`
    CREATE TRIGGER bot_template_version_immutable BEFORE UPDATE OR DELETE ON bot_template_version
    FOR EACH ROW EXECUTE FUNCTION bot_template_version_immutable()
  `.execute(db)

  await sql`
    ALTER TABLE bot_template
      ADD CONSTRAINT bot_template_current_fk FOREIGN KEY (id, current_version)
      REFERENCES bot_template_version (template_id, version) DEFERRABLE INITIALLY DEFERRED
  `.execute(db)
}
