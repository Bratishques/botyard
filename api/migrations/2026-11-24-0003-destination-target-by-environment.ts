import { type Kysely, sql } from 'kysely'

/**
 * Уникальность цели — по окружению Dokploy (и серверу), без адреса.
 *
 * Прежний индекс включал `base_url` и ловил разные написания одного адреса, но не псевдонимы: IP вместо
 * имени, второе DNS-имя, другой прокси перед тем же Dokploy. `environmentId` в Dokploy — случайный
 * идентификатор инстанса, поэтому он сам по себе определяет окружение, как бы к нему ни обращались.
 *
 * Если в базе уже есть одно окружение под разными адресами, создание индекса упадёт, транзакция откатится
 * и прежний индекс останется. Найти дубли: `SELECT environment_id, server_id, count(*) FROM destination
 * GROUP BY 1, 2 HAVING count(*) > 1`; лишние строки удалить (на назначения пока ничего не ссылается,
 * аудит хранит только id) — выключение не поможет, индекс полный — и повторить миграцию.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX destination_target_uq`.execute(db)
  await sql`CREATE UNIQUE INDEX destination_target_uq ON destination (environment_id, coalesce(server_id, ''))`.execute(db)
}
