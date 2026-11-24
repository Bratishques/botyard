import { type Kysely, sql } from 'kysely'

/**
 * Операторы админки и их сессии.
 *
 * Пароль — только хеш argon2id (`Bun.password`). Токен сессии в базе не хранится: только его
 * SHA-256, поэтому дамп таблицы не даёт войти. Сессия живёт до `expires_at` или до отзыва.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE operator (
      id            uuid PRIMARY KEY,
      email         text NOT NULL CHECK (email = lower(email) AND email ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
      password_hash text NOT NULL CHECK (password_hash LIKE '$argon2id$%'),
      created_at    timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db)
  await sql`CREATE UNIQUE INDEX operator_email_uq ON operator (email)`.execute(db)

  await sql`
    CREATE TABLE operator_session (
      token_hash  bytea PRIMARY KEY CHECK (octet_length(token_hash) = 32),
      operator_id uuid NOT NULL REFERENCES operator (id),
      created_at  timestamptz NOT NULL DEFAULT now(),
      expires_at  timestamptz NOT NULL,
      revoked_at  timestamptz,
      CHECK (expires_at > created_at)
    )
  `.execute(db)
  await sql`CREATE INDEX operator_session_operator_idx ON operator_session (operator_id)`.execute(db)
}
