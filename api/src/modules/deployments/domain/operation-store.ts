import type { DeploymentStatus, OperationKind } from './deployment'
import type { SagaStep } from './saga'

/** Шаг операции, арендованный воркером */
export interface ClaimedStep {
  readonly operationId: string
  readonly deploymentId: string
  readonly kind: OperationKind
  readonly step: SagaStep
  /** Номер попытки этого шага, с 1: для политики повторов */
  readonly attempt: number
  /** Идентификатор аренды; входит в условие всех записей воркера */
  readonly leaseId: string
  readonly context: Readonly<Record<string, unknown>>
}

/** Почему шаг не арендован */
export type ClaimRefusal =
  /** Операция завершена, шаг уже другой или операции нет: сообщение устарело, его отбросить */
  | { readonly reason: 'stale' }
  /** Шаг выполняет другой воркер; аренда кончится в `until` */
  | { readonly reason: 'leased'; readonly until: Date }

/** Незавершённая операция без аренды и без движения дольше порога: её команда, вероятно, потерялась */
export interface StalledOperation {
  readonly operationId: string
  readonly deploymentId: string
  readonly kind: ClaimedStep['kind']
  readonly step: SagaStep
  /** Сколько раз reconciler уже будил её на этом шаге без прогресса */
  readonly kicks: number
}

/** Итог операции для развёртывания */
export interface Finish {
  readonly operation: 'SUCCEEDED' | 'FAILED'
  readonly error: string | null
  readonly deploymentStatus: DeploymentStatus
  /** `undefined` — не менять */
  readonly dokployAppId?: string | null
}

/**
 * Состояние операций для воркера саги. Все записи — условные: по id операции, шагу и идентификатору аренды.
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
  /** Застрявшие операции: не завершены, аренды нет или истекла, `updated_at` старше `idleMs` */
  stalled(idleMs: number, limit: number): Promise<StalledOperation[]>
  /**
   * Разбудить: новая метка пробуждения `wake` (старая команда, если доедет, устареет), счётчик пинков +1,
   * `updated_at` — сейчас. Условно: тот же шаг, всё ещё застряла, пинков столько же, сколько прочитано
   */
  kick(stalled: StalledOperation, wake: string, idleMs: number): Promise<boolean>
  /** Сдаться: операция FAILED, итог в развёртывание (только если активная — она) — при тех же условиях */
  abandon(stalled: StalledOperation, finish: Finish, idleMs: number): Promise<boolean>
  /**
   * Разбудить ожидание деплоя приложения `appName` на назначении (вебхук Dokploy о сборке): операция, активная у
   * развёртывания, на шаге `await_deploy`, шаг сейчас не арендован. Новая метка пробуждения делает отложенный опрос
   * устаревшим — вместо него сразу пойдёт команда из этого вызова. `null` — будить нечего
   */
  nudgeAwaitingDeploy(destinationId: string, appName: string, wake: string): Promise<StalledOperation | null>
}

export const OPERATION_STORE = Symbol('OPERATION_STORE')
