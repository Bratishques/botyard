import type { TradingMode } from '../../customers/domain/customer'

export type DeploymentStatus = 'PROVISIONING' | 'RUNNING' | 'STOPPED' | 'FAILED' | 'DELETING' | 'DELETED'
export type OperationKind = 'PROVISION' | 'START' | 'STOP' | 'REDEPLOY' | 'DELETE'
export type OperationStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED'

/**
 * Расхождение с Dokploy, замеченное reconciler'ом: робота остановили, запустили или удалили руками в Dokploy,
 * или его передеплой там упал. Наблюдение, а не статус — оператор решает, что делать
 */
export type DeploymentDrift = 'APP_MISSING' | 'STOPPED_IN_DOKPLOY' | 'RUNNING_IN_DOKPLOY' | 'FAILED_IN_DOKPLOY'

/**
 * Дрейф по статусу развёртывания и состоянию приложения в Dokploy (`appStatus`). `undefined` — вывода нет
 * (идёт сборка, незнакомое состояние): прежнее наблюдение остаётся. Правила — по поведению Dokploy v0.31.4:
 * stop ставит `idle`, успешный start и деплой — `done`, упавшая сборка — `error`
 */
export function driftOf(status: DeploymentStatus, appStatus: string): DeploymentDrift | null | undefined {
  if (appStatus === 'missing') return 'APP_MISSING'
  if (appStatus === 'running') return undefined
  if (status === 'RUNNING') {
    if (appStatus === 'idle') return 'STOPPED_IN_DOKPLOY'
    if (appStatus === 'error') return 'FAILED_IN_DOKPLOY'
    return appStatus === 'done' ? null : undefined
  }
  if (status === 'STOPPED') {
    if (appStatus === 'done') return 'RUNNING_IN_DOKPLOY'
    return appStatus === 'idle' || appStatus === 'error' ? null : undefined
  }
  // FAILED: у Dokploy своя правда об упавшем; расхождение — только если приложения нет
  return null
}

/**
 * Развёртывание — робот конкретного клиента на конкретном назначении из конкретной версии шаблона.
 *
 *            provision                 deploy ok
 *  (create) ──────────► PROVISIONING ───────────► RUNNING ◄──────┐
 *                           │                       │  stop      │ start
 *                           │ отказ                 ▼            │
 *                           ▼                   STOPPED ─────────┘
 *                         FAILED ── redeploy ──► (операция) ──► RUNNING / FAILED
 *    любое, кроме DELETED ── delete ──► DELETING ──► DELETED (терминально)
 *
 * Над развёртыванием идёт не больше одной операции: её захватывает условная запись
 * `active_operation_id IS NULL` вместе с проверкой допустимого статуса. Удаление из DELETING без активной
 * операции — повтор упавшего удаления.
 *
 * `tradingMode` — режим клиента на момент создания. Воркер подставляет токен только этого режима; смена
 * режима клиента при живых развёртываниях запрещена (см. CustomerUseCases.goLive).
 */
export interface Deployment {
  readonly id: string
  readonly customerId: string
  readonly destinationId: string
  readonly templateId: string
  readonly templateVersion: string
  readonly config: Record<string, unknown>
  readonly tradingMode: TradingMode
  readonly appName: string
  readonly status: DeploymentStatus
  readonly dokployAppId: string | null
  readonly activeOperationId: string | null
  readonly lastError: string | null
  readonly drift: DeploymentDrift | null
  readonly driftCheckedAt: Date | null
  readonly version: number
  readonly createdAt: Date
  readonly updatedAt: Date
}

export interface Operation {
  readonly id: string
  readonly deploymentId: string
  readonly kind: OperationKind
  readonly status: OperationStatus
  readonly step: string | null
  readonly attempt: number
  readonly error: string | null
  readonly requestedBy: string
  readonly createdAt: Date
  readonly finishedAt: Date | null
}

export interface OperationRule {
  /** Статусы, из которых операцию можно захватить */
  readonly from: readonly DeploymentStatus[]
  /** Статус, который развёртывание получает при захвате; `null` — прежний */
  readonly claimAs: DeploymentStatus | null
  /**
   * Нужно ли включённое назначение. Выключенное назначение — «нового не принимаем»: запуск и передеплой
   * запрещены, а остановить и удалить существующее можно всегда
   */
  readonly requiresActiveDestination: boolean
}

export const OPERATION_RULES: Readonly<Record<Exclude<OperationKind, 'PROVISION'>, OperationRule>> = {
  START: { from: ['STOPPED'], claimAs: null, requiresActiveDestination: true },
  // Из FAILED тоже: упавший запуск мог оставить робота перезапускаться в цикле, остановить его можно всегда
  STOP: { from: ['RUNNING', 'FAILED'], claimAs: null, requiresActiveDestination: false },
  REDEPLOY: { from: ['RUNNING', 'STOPPED', 'FAILED'], claimAs: null, requiresActiveDestination: true },
  DELETE: { from: ['PROVISIONING', 'RUNNING', 'STOPPED', 'FAILED', 'DELETING'], claimAs: 'DELETING', requiresActiveDestination: false },
}

/**
 * Имя приложения в Dokploy — из id развёртывания. Это ключ поиска перед `application.create`, у которого
 * нет своего ключа идемпотентности (docs/architecture.md, сага). Берётся случайный хвост UUIDv7, а не
 * начало: начало — время, у двух развёртываний в одну миллисекунду оно совпало бы.
 */
export function appNameOf(deploymentId: string): string {
  return `by-${deploymentId.replace(/-/g, '').slice(-12)}`
}

export const DeploymentErrorCode = {
  NOT_FOUND: 'DEPLOYMENT_NOT_FOUND',
  VERSION_CONFLICT: 'DEPLOYMENT_VERSION_CONFLICT',
  OPERATION_IN_PROGRESS: 'DEPLOYMENT_OPERATION_IN_PROGRESS',
  INVALID_STATE: 'DEPLOYMENT_INVALID_STATE',
  INVALID_CONFIG: 'DEPLOYMENT_INVALID_CONFIG',
  CUSTOMER_UNAVAILABLE: 'DEPLOYMENT_CUSTOMER_UNAVAILABLE',
  DESTINATION_UNAVAILABLE: 'DEPLOYMENT_DESTINATION_UNAVAILABLE',
  TEMPLATE_UNAVAILABLE: 'DEPLOYMENT_TEMPLATE_UNAVAILABLE',
  TEMPLATE_NOT_LIVE_SAFE: 'DEPLOYMENT_TEMPLATE_NOT_LIVE_SAFE',
} as const
export type DeploymentErrorCode = (typeof DeploymentErrorCode)[keyof typeof DeploymentErrorCode]

export class DeploymentError extends Error {
  override readonly name = 'DeploymentError'

  constructor(
    readonly code: DeploymentErrorCode,
    message: string,
  ) {
    super(message)
  }
}

/** Основание для создания развёртывания, прочитанное под блокировкой в той же транзакции */
export interface DeploymentBasis {
  readonly customer: { readonly id: string; readonly status: string; readonly sandbox: boolean } | null
  readonly destination: { readonly id: string; readonly status: string } | null
  readonly template: {
    readonly id: string
    readonly currentVersion: string
    readonly retired: boolean
    readonly configSchema: Record<string, unknown>
    /** Проверяет ли робот сертификат T-Invest; нет — только песочница */
    readonly verifiesTls: boolean
  } | null
}

export interface DeploymentRepository {
  /** Клиент, назначение и шаблон под `FOR SHARE`: архивация, смена режима и выключение ждут конца создания */
  lockBasis(customerId: string, destinationId: string, templateId: string): Promise<DeploymentBasis>
  insert(
    deployment: Omit<Deployment, 'version' | 'createdAt' | 'updatedAt' | 'dokployAppId' | 'lastError' | 'drift' | 'driftCheckedAt'>,
  ): Promise<Deployment>
  insertOperation(operation: { id: string; deploymentId: string; kind: OperationKind; requestedBy: string }): Promise<Operation>
  findById(id: string): Promise<Deployment | null>
  list(): Promise<Deployment[]>
  operations(deploymentId: string): Promise<Operation[]>
  /**
   * Захват операции: только если активной операции нет, версия совпадает и статус допустим. `null` —
   * условие не выполнено (идёт другая операция, развёртывание изменили, недопустимый статус).
   */
  claim(
    id: string,
    expectedVersion: number,
    operationId: string,
    from: readonly DeploymentStatus[],
    claimAs: DeploymentStatus | null,
  ): Promise<Deployment | null>
  /**
   * Развёртывания для сверки дрейфа: без активной операции, в RUNNING, STOPPED или FAILED, на невыключенном
   * назначении, не сверявшиеся дольше `intervalMs` (никогда — первыми)
   */
  dueForDriftCheck(intervalMs: number, limit: number): Promise<Deployment[]>
  /**
   * Записать итог сверки: `drift` (`undefined` — вывода нет, прежнее наблюдение остаётся) и время. Условно:
   * версия та же и операции нет — начатая оператором операция важнее наблюдения. Версию не поднимает: это
   * наблюдение, а не правка, и оно не должно ломать оператору условную запись. Возвращает прежнее значение
   * дрейфа или `false`, если запись не прошла
   */
  recordDrift(id: string, version: number, drift: DeploymentDrift | null | undefined): Promise<{ previous: DeploymentDrift | null } | false>
  /** Статус назначения под `FOR SHARE`: выключение ждёт конца транзакции, а не проскакивает мимо */
  lockDestinationStatus(destinationId: string): Promise<string | null>
}

export const DEPLOYMENT_REPOSITORY = Symbol('DEPLOYMENT_REPOSITORY')
