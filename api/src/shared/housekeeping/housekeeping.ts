import { Global, Injectable, Module } from '@nestjs/common'
import { Counter } from 'prom-client'
import { IDEMPOTENCY_TTL_MS, Idempotency } from '../idempotency/idempotency'
import { registry } from '../observability/metrics'
import { Outbox } from '../outbox/outbox'

const purged = new Counter({
  name: 'botyard_housekeeping_purged_total',
  help: 'Строки служебных таблиц, удалённые по возрасту',
  labelNames: ['table'],
  registers: [registry],
})

export const HOUSEKEEPING = {
  /** Опубликованные сообщения outbox хранятся неделю — для разбора, что и когда уходило в брокер */
  outboxRetentionMs: 7 * 24 * 60 * 60_000,
  idempotencyTtlMs: IDEMPOTENCY_TTL_MS,
  batch: 1_000,
  /** Порций за проход: остальное — в следующий тик, а не одной долгой серией */
  maxBatches: 10,
} as const

/**
 * Очистка служебных таблиц, которые иначе растут без предела: опубликованный outbox и ключи идемпотентности.
 * Удаление порциями — каждая отдельной короткой транзакцией. Несколько экземпляров параллельно безопасны:
 * удаляются только строки, которые уже никому не нужны.
 */
@Injectable()
export class Housekeeping {
  constructor(
    private readonly outbox: Outbox,
    private readonly idempotency: Idempotency,
  ) {}

  async tick(): Promise<{ outbox: number; idempotency: number }> {
    const outbox = await drain(() => this.outbox.purgePublished(HOUSEKEEPING.outboxRetentionMs, HOUSEKEEPING.batch))
    const idempotency = await drain(() => this.idempotency.purgeExpired(HOUSEKEEPING.idempotencyTtlMs, HOUSEKEEPING.batch))
    purged.inc({ table: 'outbox_message' }, outbox)
    purged.inc({ table: 'idempotency_record' }, idempotency)

    return { outbox, idempotency }
  }
}

async function drain(batch: () => Promise<number>): Promise<number> {
  let total = 0
  for (let round = 0; round < HOUSEKEEPING.maxBatches; round++) {
    const deleted = await batch()
    total += deleted
    if (deleted < HOUSEKEEPING.batch) break
  }

  return total
}

@Global()
@Module({ providers: [Housekeeping], exports: [Housekeeping] })
export class HousekeepingModule {}
