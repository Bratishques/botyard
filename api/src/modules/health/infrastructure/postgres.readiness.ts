import { Inject, Injectable } from '@nestjs/common'
import { DB, type Db, pingDb } from '../../../shared/database/database'
import type { ReadinessCheck } from '../domain/readiness-check'

const PROBE_TIMEOUT_MS = 2_000

/**
 * Готовность Postgres. У пробы свой таймаут: зависший `select 1` не должен держать ответ
 * балансировщику дольше, чем тот ждёт сам.
 */
@Injectable()
export class PostgresReadiness implements ReadinessCheck {
  readonly name = 'postgres'

  constructor(@Inject(DB) private readonly db: Db) {}

  async probe(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer in ${PROBE_TIMEOUT_MS} ms`)), PROBE_TIMEOUT_MS)
    })

    try {
      await Promise.race([pingDb(this.db), timeout])
    } finally {
      clearTimeout(timer)
    }
  }
}
