import { AsyncLocalStorage } from 'node:async_hooks'
import { Inject, Injectable } from '@nestjs/common'
import type { Transaction } from 'kysely'
import { DB, type Db } from './database'
import type { Database } from './schema'

/**
 * Транзакция без протаскивания её через аргументы. Сценарий оборачивает шаг в `run`, а репозитории
 * берут соединение через `db()`: внутри `run` это транзакция, снаружи — общий пул.
 *
 * Вложенный `run` переиспользует внешнюю транзакцию: сценарий, вызванный из другого сценария,
 * не открывает вторую и не коммитит раньше времени.
 *
 * Внешние вызовы (Dokploy) внутри `run` запрещены правилами гонок: транзакция держит блокировки,
 * пока ждёт сеть, а откат не отменит сделанное снаружи.
 */
@Injectable()
export class UnitOfWork {
  private readonly current = new AsyncLocalStorage<Transaction<Database>>()

  constructor(@Inject(DB) private readonly root: Db) {}

  db(): Db | Transaction<Database> {
    return this.current.getStore() ?? this.root
  }

  run<T>(work: () => Promise<T>): Promise<T> {
    if (this.current.getStore()) return work()

    return this.root.transaction().execute((trx) => this.current.run(trx, work))
  }
}
