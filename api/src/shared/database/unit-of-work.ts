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
  private readonly current = new AsyncLocalStorage<{ trx: Transaction<Database>; afterCommit: (() => void)[] }>()

  constructor(@Inject(DB) private readonly root: Db) {}

  db(): Db | Transaction<Database> {
    return this.current.getStore()?.trx ?? this.root
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.current.getStore()) return work()

    const afterCommit: (() => void)[] = []
    const result = await this.root.transaction().execute((trx) => this.current.run({ trx, afterCommit }, work))
    for (const action of afterCommit) {
      try {
        action()
      } catch {
        // Действия после коммита — «лучшее усилие» (уведомления): их сбой не отменяет записанное
      }
    }

    return result
  }

  /**
   * Действие после коммита самой внешней транзакции — для сигналов наружу (событие «развёртывание изменилось»):
   * внутри вложенного `run` коммита ещё нет, и читатель по сигналу увидел бы старое состояние. При откате действие
   * не выполняется. Вне транзакции — сразу
   */
  afterCommit(action: () => void): void {
    const store = this.current.getStore()
    if (store) store.afterCommit.push(action)
    else action()
  }
}
