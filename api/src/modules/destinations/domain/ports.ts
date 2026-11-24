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
  /** Сброс ошибки прошлой проверки при возврате в ACTIVE */
  readonly lastError?: null
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
  /**
   * Блокирует строку назначения (FOR UPDATE) и отвечает, есть ли на нём неудалённые развёртывания. Создание
   * развёртывания держит назначение под FOR SHARE и не проскочит мимо
   */
  hasLiveDeployments(id: string): Promise<boolean>
  /** Id приложений Dokploy неудалённых развёртываний назначения */
  liveApplicationIds(id: string): Promise<string[]>
  insert(destination: NewDestination): Promise<Destination>
  findById(id: string): Promise<Destination | null>
  list(): Promise<Destination[]>
  /**
   * Правка оператора: только при совпадении версии, версия растёт. `unlessStatus` — не писать, если статус
   * уже такой: повторное включение или выключение не поднимает версию.
   */
  update(
    id: string,
    expectedVersion: number,
    changes: DestinationChanges,
    options?: { unlessStatus?: DestinationStatus },
  ): Promise<Destination | null>
  /**
   * Результат проверки связи: только если с момента чтения ключ и адрес не менялись (та же версия)
   * назначение не выключено и записанный результат не свежее этого. Версию не меняет: это не правка оператора.
   */
  recordCheck(id: string, checkedVersion: number, result: CheckResult): Promise<Destination | null>
}

export const DESTINATION_REPOSITORY = Symbol('DESTINATION_REPOSITORY')

/** Что Botyard узнаёт от Dokploy о назначении при добавлении и проверке */
export interface DokployCatalog {
  environments(baseUrl: string, apiKey: string): Promise<{ projectId: string; environmentId: string; name: string }[]>
  servers(baseUrl: string, apiKey: string): Promise<{ serverId: string; name: string }[]>
  /**
   * Id приложений окружения, которые видит этот ключ. Dokploy показывает пользователю только приложения,
   * к которым у него есть доступ: ключ другого пользователя не увидит роботов, созданных прежним ключом
   */
  applicationIds(baseUrl: string, apiKey: string, environmentId: string): Promise<Set<string>>
}

export const DOKPLOY_CATALOG = Symbol('DOKPLOY_CATALOG')
