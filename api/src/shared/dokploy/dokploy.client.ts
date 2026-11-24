import type { z } from 'zod'
import { type BreakerOptions, CircuitBreaker, CircuitOpenError, DEFAULT_BREAKER } from '../resilience/circuit-breaker'
import { DEFAULT_RETRY, type RetryPolicy, withRetry } from '../resilience/retry'
import { DokployRejectedError, DokployResponseError, DokployUnauthorizedError, DokployUnavailableError } from './dokploy.errors'
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

  private read<S extends z.ZodType>(target: DokployTarget, method: string, schema: S, signal?: AbortSignal): Promise<z.infer<S>> {
    const breaker = this.breakerFor(target.baseUrl)

    return withRetry(
      this.options.retry,
      {
        classify: (error) => ({
          retry: error instanceof DokployUnavailableError && !(error.cause instanceof CircuitOpenError),
          retryAfterMs: error instanceof DokployUnavailableError ? error.retryAfterMs : undefined,
        }),
        random: this.options.random,
        signal,
      },
      () => breaker.run(() => this.get(target, method, schema, signal), isTargetFailure).catch(wrapCircuitOpen(method)),
    )
  }

  private async get<S extends z.ZodType>(target: DokployTarget, method: string, schema: S, signal?: AbortSignal): Promise<z.infer<S>> {
    const timeout = AbortSignal.timeout(this.options.timeoutMs)
    const url = `${target.baseUrl}/api/${method}`
    let response: Response
    try {
      response = await this.fetch(url, {
        method: 'GET',
        headers: { 'x-api-key': target.apiKey, accept: 'application/json' },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        redirect: 'error',
      })
    } catch (error) {
      if (signal?.aborted) throw error
      const reason = timeout.aborted ? `no answer in ${this.options.timeoutMs} ms` : 'network error'
      throw new DokployUnavailableError(`dokploy ${method}: ${reason}`, undefined, { cause: error })
    }

    if (!response.ok) throw await failure(method, response)

    const parsed = schema.safeParse(await response.json().catch(() => undefined))
    if (!parsed.success) {
      throw new DokployResponseError(`dokploy ${method}: unexpected response shape (${parsed.error.issues[0]?.path.join('.') ?? '?'})`)
    }

    return parsed.data
  }

  private breakerFor(baseUrl: string): CircuitBreaker {
    let breaker = this.breakers.get(baseUrl)
    if (!breaker) {
      breaker = new CircuitBreaker(this.options.breaker)
      this.breakers.set(baseUrl, breaker)
    }

    return breaker
  }
}

/** Отказ адресата — недоступность и непонятный ответ. Неверный ключ и отклонённый запрос — не его отказ */
function isTargetFailure(error: unknown): boolean {
  return error instanceof DokployUnavailableError || error instanceof DokployResponseError
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
  if (response.status === 429) return new DokployUnavailableError(message, retryAfterMs(response.headers.get('retry-after')))
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
