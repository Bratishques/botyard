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
  version: number
  createdAt: string
  updatedAt: string
}
