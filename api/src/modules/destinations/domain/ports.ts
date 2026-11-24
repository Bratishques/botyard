import type { Destination, DestinationStatus } from './destination'

export interface NewDestination {
  readonly id: string
  readonly name: string
  readonly baseUrl: string
  readonly apiKeySealed: Uint8Array
  readonly apiKeyHint: string
  readonly projectId: string
  readonly environmentId: string
  readonly serverId: string | null
}

export interface DestinationChanges {
  readonly name?: string
  readonly baseUrl?: string
  readonly apiKeySealed?: Uint8Array
  readonly apiKeyHint?: string
  readonly projectId?: string
  readonly environmentId?: string
  readonly serverId?: string | null
  readonly status?: DestinationStatus
}

export interface CheckResult {
  readonly status: 'ACTIVE' | 'UNREACHABLE'
  readonly error: string | null
  readonly checkedAt: Date
}

/** Нарушение уникальности при записи: имя или адрес+окружение+сервер уже заняты */
export class DestinationConflict extends Error {
  constructor(readonly field: 'name' | 'target') {
    super(`destination ${field} is taken`)
  }
}

/**
 * Хранилище назначений. Все изменения — условные записи: по `version` для правок оператора,
 * по `version` и статусу для результата проверки. `null` — запись не изменилась, потому что
 * условие не выполнено (её поменял кто-то другой или её нет).
 */
export interface DestinationRepository {
  insert(destination: NewDestination): Promise<Destination>
  findById(id: string): Promise<Destination | null>
  list(): Promise<Destination[]>
  /** Правка оператора: только при совпадении версии, версия растёт */
  update(id: string, expectedVersion: number, changes: DestinationChanges): Promise<Destination | null>
  /**
   * Результат проверки связи: только если с момента чтения ключ и адрес не менялись (та же версия)
   * и назначение не выключено. Версию не меняет: это не правка оператора.
   */
  recordCheck(id: string, checkedVersion: number, result: CheckResult): Promise<Destination | null>
}

export const DESTINATION_REPOSITORY = Symbol('DESTINATION_REPOSITORY')

/** Что Botyard узнаёт от Dokploy о назначении при добавлении и проверке */
export interface DokployCatalog {
  environments(baseUrl: string, apiKey: string): Promise<{ projectId: string; environmentId: string; name: string }[]>
  servers(baseUrl: string, apiKey: string): Promise<{ serverId: string; name: string }[]>
}

export const DOKPLOY_CATALOG = Symbol('DOKPLOY_CATALOG')
