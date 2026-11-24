import type { DeploymentStatus, OperationKind } from './deployment'

/**
 * Сага операции над развёртыванием: последовательность шагов, по одному на сообщение `operation.step`.
 * Каждый шаг повторяем — вызовы Dokploy либо перезаписывают одно и то же, либо предварены проверкой:
 *
 *   ensure_app      найти приложение по appName в окружении назначения, нет — создать (у create нет ключа
 *                   идемпотентности, и потерянный ответ не должен дать второе приложение)
 *   configure       источник, сборка, env и файлы — перезапись; файлы — по mountPath
 *   prepare_deploy  запомнить последний деплой Dokploy до запуска: по нему видно, запущен ли наш
 *   deploy          запустить, если после запомненного нового деплоя ещё нет (повтор после таймаута)
 *   await_deploy    опрашивать новый деплой до done или error — ожидание живёт в outbox, не в воркере
 *   start | stop    идемпотентны в Dokploy
 *   delete          найти все приложения по appName и удалить; «не найдено» — уже удалено
 */
export const SagaStep = {
  ENSURE_APP: 'ensure_app',
  CONFIGURE: 'configure',
  PREPARE_DEPLOY: 'prepare_deploy',
  DEPLOY: 'deploy',
  AWAIT_DEPLOY: 'await_deploy',
  START: 'start',
  STOP: 'stop',
  DELETE: 'delete',
} as const
export type SagaStep = (typeof SagaStep)[keyof typeof SagaStep]

const DEPLOY_STEPS: readonly SagaStep[] = [
  SagaStep.ENSURE_APP,
  SagaStep.CONFIGURE,
  SagaStep.PREPARE_DEPLOY,
  SagaStep.DEPLOY,
  SagaStep.AWAIT_DEPLOY,
]

export const SAGA: Readonly<Record<OperationKind, readonly SagaStep[]>> = {
  PROVISION: DEPLOY_STEPS,
  // Передеплой — тот же путь: конфиг и токен перерисовываются, приложение находится по appName
  REDEPLOY: DEPLOY_STEPS,
  START: [SagaStep.START],
  STOP: [SagaStep.STOP],
  DELETE: [SagaStep.DELETE],
}

/** Статус развёртывания после операции. Упавшее удаление оставляет DELETING: его можно повторить */
export const OUTCOME: Readonly<Record<OperationKind, { readonly succeeded: DeploymentStatus; readonly failed: DeploymentStatus }>> = {
  PROVISION: { succeeded: 'RUNNING', failed: 'FAILED' },
  REDEPLOY: { succeeded: 'RUNNING', failed: 'FAILED' },
  START: { succeeded: 'RUNNING', failed: 'FAILED' },
  STOP: { succeeded: 'STOPPED', failed: 'FAILED' },
  DELETE: { succeeded: 'DELETED', failed: 'DELETING' },
}

/**
 * Шаги, которым нужно включённое назначение: всё, что ведёт к запуску робота, до самого запуска. После
 * `deploy` деплой уже идёт в Dokploy — отказ на `await_deploy` назвал бы операцию упавшей, а робот бы
 * запустился. Остановка и удаление разрешены на выключенном назначении всегда.
 */
export const NEEDS_ACTIVE_DESTINATION: ReadonlySet<SagaStep> = new Set([
  SagaStep.ENSURE_APP,
  SagaStep.CONFIGURE,
  SagaStep.PREPARE_DEPLOY,
  SagaStep.DEPLOY,
  SagaStep.START,
])

export function firstStep(kind: OperationKind): SagaStep {
  const [first] = SAGA[kind]
  if (!first) throw new Error(`saga for ${kind} has no steps`)

  return first
}

/** Следующий шаг; `null` — операция завершена */
export function nextStep(kind: OperationKind, step: SagaStep): SagaStep | null {
  const steps = SAGA[kind]
  const index = steps.indexOf(step)
  if (index === -1) throw new Error(`step ${step} does not belong to ${kind}`)

  return steps[index + 1] ?? null
}

const STEPS: ReadonlySet<string> = new Set(Object.values(SagaStep))

export function isSagaStep(value: string): value is SagaStep {
  return STEPS.has(value)
}

/** Политика повторов шага при временной ошибке и опроса деплоя */
export const RETRY = {
  /** Попыток одного шага, включая первую */
  maxAttempts: 6,
  baseMs: 5_000,
  maxDelayMs: 5 * 60_000,
  /**
   * Шаг арендуется на это время. Худший успешный configure по таймаутам клиента — около 100 с (три записи,
   * чтение с повторами, mount'ы); аренда с запасом в три раза
   */
  leaseMs: 5 * 60_000,
  /**
   * Пауза перед повтором ensure_app не короче этого: create, ответ на который не дошёл, мог ещё не завершиться
   * в Dokploy, и поиск сразу после таймаута его не увидит — получится второе приложение
   */
  ensureAppMinDelayMs: 15_000,
  pollMs: 10_000,
  /** Деплой дольше этого — отказ операции; сборка Go-робота в песочнице занимала ~1,5 мин */
  deployDeadlineMs: 30 * 60_000,
} as const

/** Пауза перед повтором: экспонента с полным jitter, не меньше Retry-After */
export function retryDelayMs(attempt: number, random: () => number = Math.random, retryAfterMs?: number): number {
  const ceiling = Math.min(RETRY.maxDelayMs, RETRY.baseMs * 2 ** Math.max(0, attempt - 1))
  const jittered = Math.round(random() * ceiling)

  return Math.max(jittered, retryAfterMs ?? 0)
}
