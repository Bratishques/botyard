import { type Kysely, sql } from 'kysely'

/**
 * Воркер саги.
 *
 * - `outbox_message.available_at` — не публиковать раньше: повтор шага с паузой и опрос идущего деплоя
 *   откладываются через outbox, а не таймером в памяти воркера, который умрёт вместе с процессом.
 * - `operation.lease_until` — аренда шага: шаг выполняет один воркер, повторная доставка того же шага
 *   во время аренды не запускает второй вызов Dokploy. `lease_id` — кто арендовал: все записи воркера
 *   условны по нему, и опоздавший воркер ничего не запишет (номер попытки для этого не годится — ожидание
 *   сбрасывает его, и номер повторяется).
 * - `operation.context` — данные между шагами (последний деплой Dokploy до запуска нового, время запуска).
 * - `operation.step` у незавершённой операции обязателен и из списка шагов саги (saga.ts): сообщение несёт шаг,
 *   и устаревшее отбрасывается сравнением с ним. Неопубликованным командам шаг дописывается. Уже опубликованные
 *   (лежат в очереди) миграция не достанет: на базе с операциями перед выкаткой очередь
 *   `botyard.operation.step` очищается, а команды незавершённых операций пишутся в outbox заново (до этого
 *   коммита боевых данных нет — только dev-стенды).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE outbox_message ADD COLUMN available_at timestamptz NOT NULL DEFAULT now()`.execute(db)
  await sql`DROP INDEX outbox_unpublished_idx`.execute(db)
  await sql`CREATE INDEX outbox_unpublished_idx ON outbox_message (available_at, id) WHERE published_at IS NULL`.execute(db)

  await sql`ALTER TABLE operation ADD COLUMN lease_until timestamptz`.execute(db)
  await sql`ALTER TABLE operation ADD COLUMN lease_id uuid`.execute(db)
  await sql`ALTER TABLE operation ADD COLUMN context jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(context) = 'object')`.execute(db)
  await sql`
    UPDATE operation SET step = CASE kind
      WHEN 'PROVISION' THEN 'ensure_app' WHEN 'REDEPLOY' THEN 'ensure_app'
      WHEN 'START' THEN 'start' WHEN 'STOP' THEN 'stop' ELSE 'delete' END
    WHERE step IS NULL AND status IN ('PENDING', 'RUNNING')
  `.execute(db)
  // Команды, записанные до воркера, — без шага: воркер отбросил бы их, и операция повисла бы
  await sql`
    UPDATE outbox_message m SET payload = m.payload || jsonb_build_object('step', o.step)
    FROM operation o
    WHERE m.published_at IS NULL AND m.topic = 'operation.step' AND NOT (m.payload ? 'step')
      AND o.id::text = m.payload->>'operationId'
  `.execute(db)
  await sql`
    ALTER TABLE operation ADD CONSTRAINT operation_step_known CHECK (step IS NULL OR step IN
      ('ensure_app', 'configure', 'prepare_deploy', 'deploy', 'await_deploy', 'start', 'stop', 'delete'))
  `.execute(db)
  await sql`
    ALTER TABLE operation ADD CONSTRAINT operation_step_while_active
      CHECK (status IN ('SUCCEEDED', 'FAILED') OR step IS NOT NULL)
  `.execute(db)
  await sql`
    ALTER TABLE operation ADD CONSTRAINT operation_lease_while_running
      CHECK (lease_until IS NULL OR status = 'RUNNING')
  `.execute(db)
  await sql`CREATE INDEX operation_unfinished_idx ON operation (updated_at) WHERE status IN ('PENDING', 'RUNNING')`.execute(db)
}
