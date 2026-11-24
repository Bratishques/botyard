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

/*
 * Поколение состояния: вызов запоминает поколение, в котором его допустили, и его исход учитывается,
 * только если состояние с тех пор не менялось. Поздний успех вызова, начатого до размыкания, не закроет
 * цепь, а поздний отказ не разомкнёт её снова.
 */

export class CircuitBreaker {
  private state: State = { kind: 'closed', failures: 0 }
  private generation = 0
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
    const admittedIn = this.generation
    try {
      const result = await call()
      if (admittedIn === this.generation) this.transition({ kind: 'closed', failures: 0 })
      return result
    } catch (error) {
      if (admittedIn === this.generation) {
        if (countsAsFailure(error)) this.recordFailure()
        else if (this.state.kind === 'half-open') this.transition({ kind: 'closed', failures: 0 })
      }
      throw error
    }
  }

  private transition(next: State): void {
    const changed = next.kind !== this.state.kind
    this.state = next
    if (changed) this.generation++
  }

  private admit(): void {
    if (this.state.kind === 'open') {
      const left = this.state.until - this.now()
      if (left > 0) throw new CircuitOpenError(left)
      this.transition({ kind: 'half-open', probing: false })
    }
    if (this.state.kind === 'half-open') {
      if (this.state.probing) throw new CircuitOpenError(0)
      this.state.probing = true
    }
  }

  private recordFailure(): void {
    if (this.state.kind === 'half-open') {
      this.transition({ kind: 'open', until: this.now() + this.options.openMs })
      return
    }
    if (this.state.kind !== 'closed') return

    const failures = this.state.failures + 1
    this.transition(
      failures >= this.options.failureThreshold ? { kind: 'open', until: this.now() + this.options.openMs } : { kind: 'closed', failures },
    )
  }
}
