import { z } from 'zod'
import { type BreakerOptions, CircuitBreaker, CircuitOpenError, DEFAULT_BREAKER } from '../resilience/circuit-breaker'
import { DEFAULT_RETRY, type RetryPolicy, withRetry } from '../resilience/retry'
import { TINVEST_ROOT_CA_PEM } from './tinvest'

/**
 * REST-прокси T-Invest API (официальный OpenAPI: github.com/RussianInvestments/investAPI,
 * src/docs/swagger-ui/openapi.yaml, `servers`). Сверено 2026-11-24.
 */
export const TINVEST_REST = {
  live: 'https://invest-public-api.tbank.ru/rest',
  sandbox: 'https://sandbox-invest-public-api.tbank.ru/rest',
} as const satisfies Record<'live' | 'sandbox', string>

const CONTRACT = 'tinkoff.public.invest.api.contract.v1'

/** Счёт T-Invest — поля, которыми пользуется Botyard (users.proto, `Account`) */
export interface TInvestAccount {
  readonly id: string
  readonly status: string
  readonly accessLevel: string
}

const accountsSchema = z.object({
  accounts: z
    .array(
      z.object({
        id: z.string(),
        // Значения по умолчанию в proto3 JSON не передаются: нет поля — значит UNSPECIFIED
        status: z.string().default('ACCOUNT_STATUS_UNSPECIFIED'),
        accessLevel: z.string().default('ACCOUNT_ACCESS_LEVEL_UNSPECIFIED'),
      }),
    )
    .default([]),
})
/** Ошибка REST-прокси: `{ code, message, description }`, в `description` — код ошибки T-Invest (40003 …) */
const errorSchema = z.object({ code: z.number().optional(), message: z.string().nullish(), description: z.string().nullish() })

/**
 * Исходы, которые различает вызывающий:
 * - `TInvestUnauthenticatedError` — токен не найден или не активен (401, код 40003): повтор не поможет;
 * - `TInvestRejectedError` — прочие 4xx (403 — недостаточно прав и т. п.);
 * - `TInvestUnavailableError` — сеть, таймаут, 5xx, лимит запросов: исход временный.
 * Токен в текст ошибок не попадает: он только в заголовке.
 */
export class TInvestError extends Error {}

export class TInvestUnauthenticatedError extends TInvestError {
  override readonly name = 'TInvestUnauthenticatedError'
}

export class TInvestRejectedError extends TInvestError {
  override readonly name = 'TInvestRejectedError'

  constructor(
    readonly status: number,
    readonly errorCode: string | null,
    message: string,
  ) {
    super(message)
  }
}

export class TInvestUnavailableError extends TInvestError {
  override readonly name = 'TInvestUnavailableError'

  constructor(
    message: string,
    readonly retryAfterMs?: number,
    options?: { cause?: unknown },
  ) {
    super(message, options)
  }
}

export interface TInvestClientOptions {
  readonly timeoutMs: number
  readonly retry: RetryPolicy
  readonly breaker: BreakerOptions
  readonly baseUrls: Readonly<Record<'live' | 'sandbox', string>>
  /** Корни TLS; по умолчанию — только корень Минцифры, которым подписан T-Invest */
  readonly ca: string | null
  /** Для тестов */
  readonly fetch?: typeof fetch
  readonly random?: () => number
}

export const DEFAULT_TINVEST_CLIENT: TInvestClientOptions = {
  timeoutMs: 10_000,
  retry: DEFAULT_RETRY,
  breaker: DEFAULT_BREAKER,
  baseUrls: TINVEST_REST,
  ca: TINVEST_ROOT_CA_PEM,
}

/**
 * Клиент T-Invest API для проверок платформы (счета клиента). Только чтения, поэтому повтор безопасен:
 * сеть, таймаут, 5xx и лимит запросов повторяются с jitter. Цепь — своя на контур (боевой, песочница).
 *
 * TLS: `tls.ca` в Bun заменяет системные корни, а не дополняет — клиент доверяет только корню Минцифры,
 * которым подписаны хосты T-Invest (`shared/tinvest/tinvest.ts`).
 */
export class TInvestClient {
  private readonly breakers: Readonly<Record<'live' | 'sandbox', CircuitBreaker>>
  private readonly fetch: typeof fetch

  constructor(private readonly options: TInvestClientOptions = DEFAULT_TINVEST_CLIENT) {
    this.fetch = options.fetch ?? globalThis.fetch
    this.breakers = { live: new CircuitBreaker(options.breaker), sandbox: new CircuitBreaker(options.breaker) }
  }

  /** Счета токена: боевые (`UsersService.GetAccounts`) или песочницы (`SandboxService.GetSandboxAccounts`) */
  async accounts(mode: 'live' | 'sandbox', token: string, signal?: AbortSignal): Promise<TInvestAccount[]> {
    const method = mode === 'live' ? 'UsersService/GetAccounts' : 'SandboxService/GetSandboxAccounts'
    const response = await this.call(mode, method, token, {}, signal)
    const parsed = accountsSchema.safeParse(response)
    if (!parsed.success) throw new TInvestUnavailableError(`t-invest ${method}: unexpected response shape`)

    return parsed.data.accounts
  }

  private call(mode: 'live' | 'sandbox', method: string, token: string, body: object, signal?: AbortSignal): Promise<unknown> {
    const breaker = this.breakers[mode]

    return withRetry(
      this.options.retry,
      {
        classify: (error) => ({
          retry: error instanceof TInvestUnavailableError && !(error.cause instanceof CircuitOpenError),
          retryAfterMs: error instanceof TInvestUnavailableError ? error.retryAfterMs : undefined,
        }),
        random: this.options.random,
        signal,
      },
      () =>
        breaker
          .run(
            () => this.post(mode, method, token, body, signal),
            (error) => error instanceof TInvestUnavailableError,
          )
          .catch((error: unknown) => {
            if (error instanceof CircuitOpenError) {
              throw new TInvestUnavailableError(`t-invest ${method}: circuit open`, error.retryInMs, { cause: error })
            }
            throw error
          }),
    )
  }

  private async post(mode: 'live' | 'sandbox', method: string, token: string, body: object, signal?: AbortSignal): Promise<unknown> {
    const timeout = AbortSignal.timeout(this.options.timeoutMs)
    let response: Response
    try {
      response = await this.fetch(`${this.options.baseUrls[mode]}/${CONTRACT}.${method}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        redirect: 'error',
        ...(this.options.ca !== null && { tls: { ca: this.options.ca } }),
      })
    } catch (error) {
      if (signal?.aborted) throw error
      const reason = timeout.aborted ? `no answer in ${this.options.timeoutMs} ms` : 'network error'
      throw new TInvestUnavailableError(`t-invest ${method}: ${reason}`, undefined, { cause: error })
    }

    if (response.ok) return response.json().catch(() => undefined)

    const parsed = errorSchema.safeParse(await response.json().catch(() => undefined))
    const code = parsed.success ? (parsed.data.description ?? null) : null
    const text = parsed.success && parsed.data.message ? ` ${parsed.data.message}` : ''
    const message = `t-invest ${method}: ${response.status}${code ? ` (${code})` : ''}${text}`
    if (response.status === 401) throw new TInvestUnauthenticatedError(message)
    if (response.status === 429 || response.status >= 500) {
      throw new TInvestUnavailableError(message, retryAfter(response.headers.get('retry-after')))
    }

    throw new TInvestRejectedError(response.status, code, message)
  }
}

function retryAfter(header: string | null): number | undefined {
  return header && /^\d+$/.test(header.trim()) ? Number(header.trim()) * 1_000 : undefined
}
