import type { DeploymentStatus, OperationKind } from './deployment'
import type { SagaStep } from './saga'

/** Шаг операции, арендованный воркером */
export interface ClaimedStep {
  readonly operationId: string
  readonly deploymentId: string
  readonly kind: OperationKind
  readonly step: SagaStep
  /** Номер попытки этого шага, с 1; входит в условие всех записей воркера */
  readonly attempt: number
  readonly context: Readonly<Record<string, unknown>>
}

/** Почему шаг не арендован */
export type ClaimRefusal =
  /** Операция завершена, шаг уже другой или операции нет: сообщение устарело, его отбросить */
  | { readonly reason: 'stale' }
  /** Шаг выполняет другой воркер; аренда кончится в `until` */
  | { readonly reason: 'leased'; readonly until: Date }

/** Итог операции для развёртывания */
export interface Finish {
  readonly operation: 'SUCCEEDED' | 'FAILED'
  readonly error: string | null
  readonly deploymentStatus: DeploymentStatus
  /** `undefined` — не менять */
  readonly dokployAppId?: string | null
}

/**
 * Состояние операций для воркера саги. Все записи — условные: по id операции, шагу и номеру попытки.
 * Воркер, у которого аренду перехватили (истекла, и шаг взял другой), не может ни продвинуть, ни завершить
 * операцию — запись вернёт `false`, и он просто выходит.
 */
export interface OperationStore {
  /**
   * Арендовать шаг: операция не завершена, текущий шаг равен `step`, аренды нет или она истекла, и метка
   * пробуждения совпадает (`wake` из сообщения и `context.wakeNonce`; у первой команды шага обе пусты).
   * Метка делает отложенную команду одноразовой: дубль, пришедший после паузы, устарел и не запустит
   * вторую цепочку повторов. Попытка увеличивается, статус операции — RUNNING.
   */
  claim(operationId: string, step: SagaStep, wake: string | null, leaseMs: number): Promise<ClaimedStep | ClaimRefusal>
  /** Перейти к шагу `next` (попытки с нуля), сохранить контекст и id приложения Dokploy */
  advance(claimed: ClaimedStep, next: SagaStep, context: Record<string, unknown>, dokployAppId?: string): Promise<boolean>
  /**
   * Отпустить аренду, оставив шаг: повтор или ожидание. Записывает новую метку пробуждения `wake` — её
   * несёт отложенная команда. `resetAttempts` — для ожидания, это не неудача
   */
  release(claimed: ClaimedStep, context: Record<string, unknown>, wake: string, options: { resetAttempts: boolean }): Promise<boolean>
  /**
   * Завершить операцию и записать итог в развёртывание (только если активная операция всё ещё эта),
   * сняв захват `active_operation_id`
   */
  finish(claimed: ClaimedStep, finish: Finish): Promise<boolean>
}

export const OPERATION_STORE = Symbol('OPERATION_STORE')
