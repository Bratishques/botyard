import type { z } from 'zod'
import { type BreakerOptions, CircuitBreaker, CircuitOpenError, DEFAULT_BREAKER } from '../resilience/circuit-breaker'
import { DEFAULT_RETRY, type RetryPolicy, withRetry } from '../resilience/retry'
import {
  DokployRateLimitedError,
  DokployRejectedError,
  DokployResponseError,
  DokployTimeoutError,
  DokployUnauthorizedError,
  DokployUnavailableError,
} from './dokploy.errors'
import { type DokployProject, type DokployServer, dokployErrorSchema, dokployProjectsSchema, dokployServersSchema } from './dokploy.schemas'

/** Куда и с каким ключом звать. Ключ — уже расшифрованный, живёт только на время вызова */
export interface DokployTarget {
  readonly baseUrl: string
  readonly apiKey: string
}

export interface DokployClientOptions {
  readonly timeoutMs: number
  readonly retry: RetryPolicy
  readonly breaker: BreakerOptions
  /** Для тестов */
  readonly fetch?: typeof fetch
  readonly random?: () => number
}

export interface CallOptions {
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
  /**
   * Таймаут — ожидаемый исход вызова, а не признак лежащего адресата (`application.start` ждёт, пока сервис
   * сойдётся): он не засчитывается цепи и не закрывает Dokploy для остальных операций
   */
  readonly timeoutIsNotFailure?: boolean
}

export const DEFAULT_DOKPLOY_CLIENT: DokployClientOptions = { timeoutMs: 10_000, retry: DEFAULT_RETRY, breaker: DEFAULT_BREAKER }

/**
 * HTTP-клиент Dokploy. Единственное место, где Botyard ходит в Dokploy (AGENTS.md: прямой `fetch`
 * из сценариев запрещён).
 *
 * - Таймаут — на каждую попытку, через `AbortSignal`: запрос действительно отменяется.
 * - Повторяются только чтения (GET): у изменяющих методов Dokploy нет ключа идемпотентности, и
 *   повтор вслепую мог бы создать второе приложение. Их повтор — решение саги, а не клиента.
 * - Цепь — своя на каждый адрес Dokploy: упавшее назначение не тормозит остальные.
 * - Ключ передаётся заголовком `x-api-key` (OpenAPI Dokploy, securitySchemes.apiKey) и не попадает
 *   ни в URL, ни в текст ошибок.
 */
export class DokployClient {
  private readonly breakers = new Map<string, CircuitBreaker>()
  private readonly fetch: typeof fetch

  constructor(private readonly options: DokployClientOptions = DEFAULT_DOKPLOY_CLIENT) {
    this.fetch = options.fetch ?? globalThis.fetch
  }

  listProjects(target: DokployTarget, signal?: AbortSignal): Promise<DokployProject[]> {
    return this.read(target, 'project.all', dokployProjectsSchema, signal)
  }

  listServers(target: DokployTarget, signal?: AbortSignal): Promise<DokployServer[]> {
    return this.read(target, 'server.all', dokployServersSchema, signal)
  }

  /**
   * Чтение `GET /api/<method>?<query>` с повторами. Схема ответа обязана выбирать только нужные поля:
   * ответы приложений Dokploy содержат env и файлы робота вместе с токеном клиента.
   */
  query<S extends z.ZodType>(
    target: DokployTarget,
    method: string,
    query: Record<string, string>,
    schema: S,
    signal?: AbortSignal,
  ): Promise<z.infer<S>> {
    return this.read(target, method, schema, signal, query)
  }

  /**
   * Изменение `POST /api/<method>` с разбором ответа — одна попытка: у Dokploy нет ключа идемпотентности,
   * повтор решает сага. Таймаут — свой у вызова: `application.start` ждёт, пока сервис сойдётся.
   */
  mutate<S extends z.ZodType>(
    target: DokployTarget,
    method: string,
    body: Record<string, unknown>,
    schema: S,
    options: CallOptions = {},
  ): Promise<z.infer<S>> {
    return this.guarded(target, method, async () => {
      const response = await this.post(target, method, body, options)
      return parse(method, schema, await response.json().catch(() => undefined))
    })
  }

  /** Изменение без нужного ответа (Dokploy отвечает `true` или пустым телом): тело не читается */
  async command(target: DokployTarget, method: string, body: Record<string, unknown>, options: CallOptions = {}): Promise<void> {
    await this.guarded(
      target,
      method,
      async () => {
        const response = await this.post(target, method, body, options)
        await response.body?.cancel()
      },
      options.timeoutIsNotFailure ? (error) => isTargetFailure(error) && !isTimeout(error) : isTargetFailure,
    )
  }

  private read<S extends z.ZodType>(
    target: DokployTarget,
    method: string,
    schema: S,
    signal?: AbortSignal,
    query?: Record<string, string>,
  ): Promise<z.infer<S>> {
    return withRetry(
      this.options.retry,
      {
        classify: (error) => ({
          retry:
            (error instanceof DokployUnavailableError && !(error.cause instanceof CircuitOpenError)) ||
            error instanceof DokployRateLimitedError,
          retryAfterMs:
            error instanceof DokployUnavailableError || error instanceof DokployRateLimitedError ? error.retryAfterMs : undefined,
        }),
        random: this.options.random,
        signal,
      },
      () =>
        this.guarded(target, method, async () => {
          const search = query && Object.keys(query).length > 0 ? `?${new URLSearchParams(query)}` : ''
          const response = await this.send(target, method, search, { method: 'GET' }, this.options.timeoutMs, signal)
          return parse(method, schema, await response.json().catch(() => undefined))
        }),
    )
  }

  /** Вызов под цепью своего адреса: недоступность и непонятный ответ считаются отказом адресата */
  private guarded<T>(
    target: DokployTarget,
    method: string,
    work: () => Promise<T>,
    countsAgainstTarget: (error: unknown) => boolean = isTargetFailure,
  ): Promise<T> {
    return this.breakerFor(target.baseUrl).run(work, countsAgainstTarget).catch(wrapCircuitOpen(method))
  }

  private async post(target: DokployTarget, method: string, body: Record<string, unknown>, options: CallOptions): Promise<Response> {
    const init = { method: 'POST' as const, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    return this.send(target, method, '', init, options.timeoutMs ?? this.options.timeoutMs, options.signal)
  }

  /** Запрос с таймаутом; не-2xx — ошибка по коду. Возвращает ответ с непрочитанным телом */
  private async send(
    target: DokployTarget,
    method: string,
    search: string,
    init: { method: 'GET' | 'POST'; headers?: Record<string, string>; body?: string },
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Response> {
    const timeout = AbortSignal.timeout(timeoutMs)
    let response: Response
    try {
      response = await this.fetch(`${target.baseUrl}/api/${method}${search}`, {
        ...init,
        headers: { ...init.headers, 'x-api-key': target.apiKey, accept: 'application/json' },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        redirect: 'error',
      })
    } catch (error) {
      if (signal?.aborted) throw error
      if (timeout.aborted) throw new DokployTimeoutError(`dokploy ${method}: no answer in ${timeoutMs} ms`, undefined, { cause: error })
      throw new DokployUnavailableError(`dokploy ${method}: network error`, undefined, { cause: error })
    }
    if (!response.ok) throw await failure(method, response)

    return response
  }

  /**
   * Цепь на адрес. Карта ограничена: предпросмотр принимает любой адрес, и без предела она росла бы
   * с каждым опечатанным URL. Вытесняется самый давно использованный адрес.
   */
  private breakerFor(baseUrl: string): CircuitBreaker {
    let breaker = this.breakers.get(baseUrl)
    if (breaker) {
      this.breakers.delete(baseUrl)
    } else {
      breaker = new CircuitBreaker(this.options.breaker)
      if (this.breakers.size >= MAX_BREAKERS) {
        const oldest = this.breakers.keys().next().value
        if (oldest !== undefined) this.breakers.delete(oldest)
      }
    }
    this.breakers.set(baseUrl, breaker)

    return breaker
  }
}

const MAX_BREAKERS = 256

/** Отказ адресата — недоступность и непонятный ответ. Неверный ключ, лимит ключа и отклонённый запрос — не его отказ */
function isTargetFailure(error: unknown): boolean {
  return error instanceof DokployUnavailableError || error instanceof DokployResponseError
}

function parse<S extends z.ZodType>(method: string, schema: S, body: unknown): z.infer<S> {
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    throw new DokployResponseError(`dokploy ${method}: unexpected response shape (${parsed.error.issues[0]?.path.join('.') ?? '?'})`)
  }

  return parsed.data
}

function isTimeout(error: unknown): boolean {
  return error instanceof DokployTimeoutError
}

function wrapCircuitOpen(method: string): (error: unknown) => never {
  return (error) => {
    if (error instanceof CircuitOpenError) {
      throw new DokployUnavailableError(`dokploy ${method}: circuit open`, error.retryInMs, { cause: error })
    }
    throw error
  }
}

async function failure(method: string, response: Response): Promise<Error> {
  const body = dokployErrorSchema.safeParse(await response.json().catch(() => undefined))
  // Текст ошибки Dokploy — для лога; ключ в него не попадает, он только в заголовке запроса
  const message = `dokploy ${method}: ${response.status}${body.success && body.data.message ? ` ${body.data.message}` : ''}`

  if (response.status === 401 || response.status === 403) return new DokployUnauthorizedError(message)
  if (response.status === 429) return new DokployRateLimitedError(message, retryAfterMs(response.headers.get('retry-after')))
  if (response.status >= 500) return new DokployUnavailableError(message)

  return new DokployRejectedError(response.status, message)
}

/** `Retry-After` — секунды или HTTP-дата (RFC 9110, 10.2.3) */
export function retryAfterMs(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined
  if (/^\d+$/.test(header.trim())) return Number(header.trim()) * 1_000
  const date = Date.parse(header)

  return Number.isNaN(date) ? undefined : Math.max(0, date - now)
}
