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
  readonly type: string
  readonly status: string
  readonly accessLevel: string
}

/**
 * Токен — печатные ASCII без пробелов: иначе Bun не соберёт заголовок `Authorization` и бросит до отправки,
 * а это выглядело бы как сбой сети — повторы и размыкание общей цепи контура
 */
const TOKEN_FORMAT = /^[\x21-\x7e]{1,512}$/

const accountsSchema = z.object({
  accounts: z
    .array(
      z.object({
        id: z.string(),
        // Значения по умолчанию в proto3 JSON не передаются: нет поля — значит UNSPECIFIED
        type: z.string().default('ACCOUNT_TYPE_UNSPECIFIED'),
        status: z.string().default('ACCOUNT_STATUS_UNSPECIFIED'),
        accessLevel: z.string().default('ACCOUNT_ACCESS_LEVEL_UNSPECIFIED'),
      }),
    )
    .default([]),
})
/**
 * Ошибка REST-прокси: `{ code, message, description }`, в `description` — код ошибки T-Invest (40003 …).
 * OpenAPI описывает его числом, живой API отдаёт строкой — принимаются оба
 */
const errorSchema = z.object({
  code: z.number().optional(),
  message: z.string().nullish(),
  description: z.union([z.string(), z.number()]).nullish(),
})

/**
 * Исходы, которые различает вызывающий:
 * - `TInvestUnauthenticatedError` — токен не найден или не активен (401, код 40003): повтор не поможет;
 * - `TInvestRejectedError` — прочие 4xx (403 — недостаточно прав и т. п.);
 * - `TInvestUnavailableError` — сеть, таймаут, 408, 5xx, лимит запросов (429): исход временный.
 * Токен в текст ошибок не попадает: он только в заголовке.
 */
export class TInvestError extends Error {}

export class TInvestUnauthenticatedError extends TInvestError {
  override readonly name = 'TInvestUnauthenticatedError'
}

/** Токен не годится для запроса по форме (пробел, кириллица): отклонён до отправки */
export class TInvestTokenFormatError extends TInvestError {
  override readonly name = 'TInvestTokenFormatError'
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
    options?: { cause?: unknown; rateLimited?: boolean },
  ) {
    super(message, options)
    this.rateLimited = options?.rateLimited ?? false
  }

  /** Лимит запросов — лимит токена, а не отказ контура: цепь из-за него не размыкается */
  readonly rateLimited: boolean
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

/**
 * Проверку ждёт оператор в запросе админки: две попытки по 8 с — до ~17 с на один вызов. Песочница делает
 * два вызова подряд (контур песочницы и боевой), то есть до ~33 с
 */
export const DEFAULT_TINVEST_CLIENT: TInvestClientOptions = {
  timeoutMs: 8_000,
  retry: { ...DEFAULT_RETRY, attempts: 2 },
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
    if (!TOKEN_FORMAT.test(token)) throw new TInvestTokenFormatError(`t-invest ${method}: the token has characters not allowed in a header`)
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
            (error) => error instanceof TInvestUnavailableError && !error.rateLimited,
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
    const description = parsed.success ? parsed.data.description : null
    const code = description === null || description === undefined ? null : String(description)
    const text = parsed.success && parsed.data.message ? ` ${parsed.data.message}` : ''
    const message = `t-invest ${method}: ${response.status}${code ? ` (${code})` : ''}${text}`
    if (response.status === 401) throw new TInvestUnauthenticatedError(message)
    if (response.status === 429) {
      // T-Invest сообщает время до сброса лимита в x-ratelimit-reset (секунды), Retry-After не шлёт
      const wait = retryAfter(response.headers.get('x-ratelimit-reset')) ?? retryAfter(response.headers.get('retry-after'))
      throw new TInvestUnavailableError(message, wait, { rateLimited: true })
    }
    // 408 — таймаут на стороне T-Invest: исход временный
    if (response.status === 408 || response.status >= 500) throw new TInvestUnavailableError(message)

    throw new TInvestRejectedError(response.status, code, message)
  }
}

function retryAfter(header: string | null): number | undefined {
  return header && /^\d+$/.test(header.trim()) ? Number(header.trim()) * 1_000 : undefined
}
