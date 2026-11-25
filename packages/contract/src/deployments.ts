import { z } from 'zod'
import type { TradingMode } from './customers'

export const deploymentCreateSchema = z
  .object({
    customerId: z.uuid(),
    destinationId: z.uuid(),
    templateId: z.string().regex(/^[a-z0-9][a-z0-9-]{1,38}$/),
    config: z.record(z.string(), z.unknown()),
  })
  .strict()
export type DeploymentCreateBody = z.infer<typeof deploymentCreateSchema>

/** Действия над развёртыванием: `POST /deployments/:id/<action>` с `{ version }` и `Idempotency-Key` */
export const DEPLOYMENT_ACTIONS = { start: 'START', stop: 'STOP', redeploy: 'REDEPLOY', delete: 'DELETE' } as const
export type DeploymentAction = keyof typeof DEPLOYMENT_ACTIONS

export type DeploymentStatus = 'PROVISIONING' | 'RUNNING' | 'STOPPED' | 'FAILED' | 'DELETING' | 'DELETED'
export type OperationKind = 'PROVISION' | 'START' | 'STOP' | 'REDEPLOY' | 'DELETE'
export type OperationStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED'

/** Расхождение с Dokploy, замеченное reconciler'ом (робота трогали руками в Dokploy). Не статус: решает оператор */
export type DeploymentDrift = 'APP_MISSING' | 'STOPPED_IN_DOKPLOY' | 'RUNNING_IN_DOKPLOY' | 'FAILED_IN_DOKPLOY'

export interface OperationView {
  id: string
  kind: OperationKind
  status: OperationStatus
  /** Текущий шаг саги (`ensure_app`, `configure`, … `delete`) */
  step: string | null
  attempt: number
  error: string | null
  requestedBy: string
  createdAt: string
  finishedAt: string | null
}

export interface DeploymentView {
  id: string
  customerId: string
  destinationId: string
  templateId: string
  templateVersion: string
  config: Record<string, unknown>
  tradingMode: TradingMode
  appName: string
  status: DeploymentStatus
  activeOperationId: string | null
  lastError: string | null
  drift: DeploymentDrift | null
  driftCheckedAt: string | null
  version: number
  createdAt: string
  updatedAt: string
}

/** Строка лога робота: время от Docker (RFC3339Nano) и текст с вычищенными секретами */
export interface LogLine {
  at: string
  text: string
}

/**
 * `GET /deployments/:id/logs`; живые логи — SSE `GET /deployments/:id/logs/stream`: события `log` с `LogLine`,
 * `logs-gap` (часть строк пропущена — робот печатал быстрее опроса) и `logs-error` с `{ code }`
 */
export interface DeploymentLogsView {
  lines: LogLine[]
}

/** SSE `GET /events/deployments`, событие `deployment`: перечитать это развёртывание через API; `resync` — перечитать всё */
export interface DeploymentChangedEvent {
  deploymentId: string
}

/** `GET /deployments/:id`: развёртывание с историей операций, новые — первыми */
export interface DeploymentDetailsView extends DeploymentView {
  operations: OperationView[]
}

/** Ответ на создание и действия: принятая операция, а не её результат — его выполняет воркер саги */
export interface DeploymentAcceptedView extends DeploymentView {
  operation: OperationView
}
