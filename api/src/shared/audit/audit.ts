import { Global, Injectable, Module } from '@nestjs/common'
import { UnitOfWork } from '../database/unit-of-work'

export interface AuditRecord {
  /** Кто: `operator:<id>` или `system:<процесс>` */
  readonly actor: string
  /** Что: `<сущность>.<действие>` — `destination.created` */
  readonly action: string
  readonly targetType: string
  readonly targetId: string | null
  /** Подробности без секретов: в аудит попадает подсказка ключа, но не ключ */
  readonly payload?: Record<string, unknown>
}

/**
 * Журнал аудита. Пишется через unit of work: внутри `run` — в той же транзакции, что и изменение,
 * поэтому изменения без записи в журнале (и запись без изменения) не бывает. Время ставит база.
 */
@Injectable()
export class AuditLog {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  async record(entry: AuditRecord): Promise<void> {
    await this.unitOfWork
      .db()
      .insertInto('audit_event')
      .values({
        id: Bun.randomUUIDv7(),
        actor: entry.actor,
        action: entry.action,
        target_type: entry.targetType,
        target_id: entry.targetId,
        payload: entry.payload ?? {},
      })
      .execute()
  }
}

@Global()
@Module({ providers: [AuditLog], exports: [AuditLog] })
export class AuditModule {}
