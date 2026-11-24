/**
 * Типизированная обёртка над fetch для админ-API.
 *
 * Инварианты:
 * - ошибка всегда `ApiError` с `code`: тело API `{ code, message }`, а сетевой сбой и непонятный ответ получают
 *   свои коды. `message` из API в интерфейс не попадает — это текст для логов, показывается текст по коду;
 * - 401 на любом запросе, кроме самого входа, означает истёкшую сессию: клиент зовёт `onUnauthenticated`
 *   (переход на вход), а вызывающий всё равно получает ошибку и не продолжает сценарий;
 * - изменяющий запрос всегда уходит JSON (API отвечает 415 на иное, это часть защиты от CSRF);
 * - `Idempotency-Key` передаётся снаружи: ключ живёт столько, сколько попытка пользователя, а не HTTP-запрос;
 * - тело успешного ответа приводится к типу контракта без проверки во время выполнения (`as T`): контракт описывает
 *   ответы интерфейсами, а api привязывает к ним свои функции ответа через tsc. Это граница доверия к своему API.
 */
import type { ErrorBody } from '@botyard/contract'

/** Коды, которые придумывает сам клиент: у API их нет */
export const CLIENT_CODES = {
  network: 'NETWORK_ERROR',
  badResponse: 'BAD_RESPONSE',
} as const

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    /** Секунды из `Retry-After` (вход под лимитом) */
    readonly retryAfter: number | null = null,
  ) {
    // В message — только код: сырой текст API не должен утечь в интерфейс через `String(error)`
    super(code)
    this.name = 'ApiError'
  }
}

export function isApiError(error: unknown, code?: string): error is ApiError {
  return error instanceof ApiError && (code === undefined || error.code === code)
}

export interface RequestOptions {
  body?: unknown
  idempotencyKey?: string
  /** Для входа: 401 там — неверный пароль, а не истёкшая сессия */
  skipAuthRedirect?: boolean
}

export interface ApiClientOptions {
  baseUrl: string
  fetch?: typeof fetch
  onUnauthenticated?: () => void
}

export type ApiClient = ReturnType<typeof createApiClient>

export function createApiClient(options: ApiClientOptions) {
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init))

  async function request<T>(method: 'GET' | 'POST' | 'PATCH', path: string, opts: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' }
    let body: string | undefined
    if (method !== 'GET') {
      headers['content-type'] = 'application/json'
      body = JSON.stringify(opts.body ?? {})
    }
    if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey

    let response: Response
    try {
      // credentials same-origin: cookie сессии ходит только на свой origin, как и задумано
      response = await doFetch(`${options.baseUrl}${path}`, { method, headers, body, credentials: 'same-origin' })
    } catch {
      throw new ApiError(0, CLIENT_CODES.network)
    }

    if (response.status === 401 && !opts.skipAuthRedirect) options.onUnauthenticated?.()

    if (!response.ok) throw await toApiError(response)
    if (response.status === 204) return undefined as T

    try {
      return (await response.json()) as T
    } catch {
      throw new ApiError(response.status, CLIENT_CODES.badResponse)
    }
  }

  return {
    get: <T>(path: string, opts: Omit<RequestOptions, 'body' | 'idempotencyKey'> = {}) => request<T>('GET', path, opts),
    post: <T>(path: string, body: unknown, opts: Omit<RequestOptions, 'body'> = {}) => request<T>('POST', path, { ...opts, body }),
    patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, { body }),
  }
}

async function toApiError(response: Response): Promise<ApiError> {
  const retryAfter = Number(response.headers.get('retry-after'))
  const retry = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null
  let parsed: unknown
  try {
    parsed = await response.json()
  } catch {
    // Тело не JSON: прокси или сервер упал до API. Код по статусу, текст не показываем
    return new ApiError(response.status, response.status >= 500 ? 'HTTP_5XX' : CLIENT_CODES.badResponse, retry)
  }
  const code = isErrorBody(parsed) ? parsed.code : response.status >= 500 ? 'HTTP_5XX' : CLIENT_CODES.badResponse
  return new ApiError(response.status, code, retry)
}

function isErrorBody(value: unknown): value is ErrorBody {
  return typeof value === 'object' && value !== null && 'code' in value && typeof value.code === 'string'
}
