import type { TradingMode } from '../../customers/domain/customer'

export type DeploymentStatus = 'PROVISIONING' | 'RUNNING' | 'STOPPED' | 'FAILED' | 'DELETING' | 'DELETED'
export type OperationKind = 'PROVISION' | 'START' | 'STOP' | 'REDEPLOY' | 'DELETE'
export type OperationStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED'

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
  STOP: { from: ['RUNNING'], claimAs: null, requiresActiveDestination: false },
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
  } | null
}

export interface DeploymentRepository {
  /** Клиент, назначение и шаблон под `FOR SHARE`: архивация, смена режима и выключение ждут конца создания */
  lockBasis(customerId: string, destinationId: string, templateId: string): Promise<DeploymentBasis>
  insert(deployment: Omit<Deployment, 'version' | 'createdAt' | 'updatedAt' | 'dokployAppId' | 'lastError'>): Promise<Deployment>
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
  /** Статус назначения под `FOR SHARE`: выключение ждёт конца транзакции, а не проскакивает мимо */
  lockDestinationStatus(destinationId: string): Promise<string | null>
}

export const DEPLOYMENT_REPOSITORY = Symbol('DEPLOYMENT_REPOSITORY')
