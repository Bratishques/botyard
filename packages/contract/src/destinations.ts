import { z } from 'zod'
import { version } from './common'

// Не короче 16: подсказка показывает 4 последних символа, у короткого ключа это слишком большая доля
const apiKey = z.string().trim().min(16).max(512)
const dokployId = z.string().trim().min(1).max(128)

export const destinationPreviewSchema = z.object({ baseUrl: z.string().max(2048), apiKey })
export type DestinationPreviewBody = z.infer<typeof destinationPreviewSchema>

export const destinationCreateSchema = z
  .object({
    name: z.string().max(200),
    baseUrl: z.string().max(2048),
    apiKey,
    environmentId: dokployId,
    serverId: dokployId.nullable().default(null),
  })
  .strict()
export type DestinationCreateBody = z.infer<typeof destinationCreateSchema>

export const destinationUpdateSchema = z
  .object({
    version,
    name: z.string().max(200).optional(),
    baseUrl: z.string().max(2048).optional(),
    apiKey: apiKey.optional(),
    environmentId: dokployId.optional(),
    serverId: dokployId.nullable().optional(),
  })
  .strict()
export type DestinationUpdateBody = z.infer<typeof destinationUpdateSchema>

export type DestinationStatus = 'ACTIVE' | 'UNREACHABLE' | 'DISABLED'

/** Назначение наружу: без конверта ключа, только подсказка */
export interface DestinationView {
  id: string
  name: string
  baseUrl: string
  apiKeyHint: string
  projectId: string
  environmentId: string
  serverId: string | null
  status: DestinationStatus
  lastCheckedAt: string | null
  lastError: string | null
  version: number
  createdAt: string
  updatedAt: string
}
