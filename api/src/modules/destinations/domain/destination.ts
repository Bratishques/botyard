/**
 * Назначение — Dokploy-инстанс (и, по желанию, удалённый сервер в нём), куда разворачиваются роботы.
 * Ключ Dokploy в домене не живёт открытым текстом: только конверт и подсказка.
 */
export const DestinationStatus = {
  ACTIVE: 'ACTIVE',
  /** Последняя проверка связи не прошла */
  UNREACHABLE: 'UNREACHABLE',
  /** Выключено оператором: новые развёртывания не принимает */
  DISABLED: 'DISABLED',
} as const
export type DestinationStatus = (typeof DestinationStatus)[keyof typeof DestinationStatus]

export interface Destination {
  readonly id: string
  readonly name: string
  readonly baseUrl: string
  readonly apiKeySealed: Uint8Array
  readonly apiKeyHint: string
  readonly projectId: string
  readonly environmentId: string
  readonly serverId: string | null
  readonly status: DestinationStatus
  readonly lastCheckedAt: Date | null
  readonly lastError: string | null
  readonly version: number
  readonly createdAt: Date
  readonly updatedAt: Date
}

export const DestinationErrorCode = {
  NOT_FOUND: 'DESTINATION_NOT_FOUND',
  NAME_TAKEN: 'DESTINATION_NAME_TAKEN',
  TARGET_TAKEN: 'DESTINATION_TARGET_TAKEN',
  INVALID_URL: 'DESTINATION_INVALID_URL',
  INVALID_NAME: 'DESTINATION_INVALID_NAME',
  INSECURE_URL: 'DESTINATION_INSECURE_URL',
  KEY_REJECTED: 'DESTINATION_KEY_REJECTED',
  KEY_REQUIRED: 'DESTINATION_KEY_REQUIRED',
  UNREACHABLE: 'DESTINATION_UNREACHABLE',
  /** Ключ Dokploy упёрся в свой лимит запросов (по умолчанию — 10 в сутки) */
  RATE_LIMITED: 'DESTINATION_RATE_LIMITED',
  ENVIRONMENT_NOT_FOUND: 'DESTINATION_ENVIRONMENT_NOT_FOUND',
  SERVER_NOT_FOUND: 'DESTINATION_SERVER_NOT_FOUND',
  VERSION_CONFLICT: 'DESTINATION_VERSION_CONFLICT',
} as const
export type DestinationErrorCode = (typeof DestinationErrorCode)[keyof typeof DestinationErrorCode]

export class DestinationError extends Error {
  override readonly name = 'DestinationError'

  constructor(
    readonly code: DestinationErrorCode,
    message: string,
  ) {
    super(message)
  }
}

const DEFAULT_PORTS: Record<string, string> = { 'http:': '80', 'https:': '443' }

/**
 * Нормализованный адрес Dokploy: схема и хост в нижнем регистре, без точки в конце хоста, без порта
 * по умолчанию, без query, фрагмента и косой черты в конце. Один инстанс — одна строка, иначе
 * уникальный индекс назначений обходится вариантами написания. Те же правила проверяет CHECK в базе.
 *
 * `http` допускается только явным флагом (локальная разработка): ключ Dokploy даёт полный доступ
 * к инстансу и по открытому каналу уходить не должен.
 */
export function normalizeBaseUrl(input: string, options: { allowHttp: boolean }): string {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    throw new DestinationError(DestinationErrorCode.INVALID_URL, 'base url is not a valid URL')
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new DestinationError(DestinationErrorCode.INVALID_URL, 'base url must be http(s)')
  }
  if (url.protocol === 'http:' && !options.allowHttp) {
    throw new DestinationError(DestinationErrorCode.INSECURE_URL, 'base url must use https')
  }
  if (url.username || url.password) {
    throw new DestinationError(DestinationErrorCode.INVALID_URL, 'base url must not contain credentials')
  }

  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(host)) throw new DestinationError(DestinationErrorCode.INVALID_URL, 'base url host is invalid')

  const port = url.port && url.port !== DEFAULT_PORTS[url.protocol] ? `:${Number(url.port)}` : ''
  const path = url.pathname.replace(/\/+$/, '')

  return `${url.protocol}//${host}${port}${path}`
}

/** Имя назначения: без пробельных краёв, 1..80 символов (как CHECK в базе) */
export function normalizeName(input: string): string {
  const name = input.trim()
  if (name.length < 1 || name.length > 80) throw new DestinationError(DestinationErrorCode.INVALID_NAME, 'name must be 1..80 characters')

  return name
}
