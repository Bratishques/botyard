import {
  DokployRejectedError,
  DokployResponseError,
  DokployUnauthorizedError,
  DokployUnavailableError,
} from '../../../shared/dokploy/dokploy.errors'
import { DestinationError, DestinationErrorCode } from '../domain/destination'
import type { DokployCatalog } from '../domain/ports'

export interface Target {
  readonly baseUrl: string
  readonly apiKey: string
  readonly environmentId: string
  readonly serverId: string | null
}

/**
 * Проверка цели в Dokploy: ключ принят, окружение существует, сервер (если указан) существует.
 * Возвращает проект окружения — его оператор не вводит, он следует из окружения.
 *
 * Вызывается вне транзакции: это сетевой вызов. Результат действует только вместе с условной
 * записью по версии, которая идёт следом.
 */
export async function verifyTarget(catalog: DokployCatalog, target: Target): Promise<{ projectId: string }> {
  try {
    const environments = await catalog.environments(target.baseUrl, target.apiKey)
    const environment = environments.find((item) => item.environmentId === target.environmentId)
    if (!environment) {
      throw new DestinationError(DestinationErrorCode.ENVIRONMENT_NOT_FOUND, `environment ${target.environmentId} is not found in dokploy`)
    }

    if (target.serverId !== null) {
      const servers = await catalog.servers(target.baseUrl, target.apiKey)
      if (!servers.some((server) => server.serverId === target.serverId)) {
        throw new DestinationError(DestinationErrorCode.SERVER_NOT_FOUND, `server ${target.serverId} is not found in dokploy`)
      }
    }

    return { projectId: environment.projectId }
  } catch (error) {
    throw toDestinationError(error)
  }
}

export function toDestinationError(error: unknown): unknown {
  if (error instanceof DestinationError) return error
  if (error instanceof DokployUnauthorizedError)
    return new DestinationError(DestinationErrorCode.KEY_REJECTED, 'dokploy rejected the api key')
  if (error instanceof DokployUnavailableError || error instanceof DokployResponseError || error instanceof DokployRejectedError) {
    return new DestinationError(DestinationErrorCode.UNREACHABLE, error.message)
  }

  return error
}
