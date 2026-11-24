/**
 * Размыкатель цепи для одного внешнего адресата (у нас — одного назначения Dokploy).
 *
 *   closed ──N отказов подряд──► open ──пауза──► half-open ──успех──► closed
 *                                  ▲                 │
 *                                  └──── отказ ──────┘
 *
 * Пока цепь разомкнута, вызов не делается вовсе: лежащий Dokploy не держит воркеры на таймаутах,
 * а поднявшись, получает один пробный запрос, а не всю накопленную очередь. В half-open пропускается
 * ровно один пробный вызов, остальные отклоняются до его исхода.
 *
 * Состояние — в памяти процесса: у каждой реплики своё. Для цепи это допустимо: она защищает
 * эту реплику от ожидания, а не координирует реплики между собой.
 */
export interface BreakerOptions {
  readonly failureThreshold: number
  readonly openMs: number
  readonly now?: () => number
}

export const DEFAULT_BREAKER: BreakerOptions = { failureThreshold: 5, openMs: 30_000 }

export class CircuitOpenError extends Error {
  override readonly name = 'CircuitOpenError'

  constructor(readonly retryInMs: number) {
    super(`circuit is open, retry in ${retryInMs} ms`)
  }
}

type State = { kind: 'closed'; failures: number } | { kind: 'open'; until: number } | { kind: 'half-open'; probing: boolean }

export class CircuitBreaker {
  private state: State = { kind: 'closed', failures: 0 }
  private readonly now: () => number

  constructor(private readonly options: BreakerOptions) {
    this.now = options.now ?? Date.now
  }

  get status(): 'closed' | 'open' | 'half-open' {
    if (this.state.kind === 'open' && this.now() >= this.state.until) return 'half-open'

    return this.state.kind
  }

  /**
   * `countsAsFailure` решает, что считать отказом адресата. Ответ «неверный ключ» — это отказ
   * вызывающего, а не адресата: из-за него цепь размыкаться не должна.
   */
  async run<T>(call: () => Promise<T>, countsAsFailure: (error: unknown) => boolean): Promise<T> {
    this.admit()
    try {
      const result = await call()
      this.state = { kind: 'closed', failures: 0 }
      return result
    } catch (error) {
      if (countsAsFailure(error)) this.recordFailure()
      else if (this.state.kind === 'half-open') this.state = { kind: 'closed', failures: 0 }
      throw error
    }
  }

  private admit(): void {
    if (this.state.kind === 'open') {
      const left = this.state.until - this.now()
      if (left > 0) throw new CircuitOpenError(left)
      this.state = { kind: 'half-open', probing: false }
    }
    if (this.state.kind === 'half-open') {
      if (this.state.probing) throw new CircuitOpenError(0)
      this.state.probing = true
    }
  }

  private recordFailure(): void {
    if (this.state.kind === 'half-open') {
      this.state = { kind: 'open', until: this.now() + this.options.openMs }
      return
    }
    if (this.state.kind !== 'closed') return

    const failures = this.state.failures + 1
    this.state =
      failures >= this.options.failureThreshold ? { kind: 'open', until: this.now() + this.options.openMs } : { kind: 'closed', failures }
  }
}
