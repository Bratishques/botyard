import {
  TInvestClient,
  TInvestRejectedError,
  TInvestTokenFormatError,
  TInvestUnauthenticatedError,
  TInvestUnavailableError,
} from '../../../shared/tinvest/tinvest.client'
import type { TradingMode } from '../domain/customer'
import { type AccountCheck, type TradingAccounts, TradingAccountsUnavailableError } from '../domain/trading-accounts'

/**
 * Проверка через T-Invest API. Боевой режим — `UsersService.GetAccounts` на боевом контуре, песочница —
 * `SandboxService.GetSandboxAccounts` на контуре песочницы (users.proto, sandbox.proto).
 *
 * - счёт должен быть в списке; боевой — в статусе `ACCOUNT_STATUS_OPEN`. Статус счетов песочницы документация
 *   не описывает (без настоящего токена песочницы не проверено), поэтому там отклоняется только закрытый;
 * - для боевого — брокерский счёт или ИИС с `ACCOUNT_ACCESS_LEVEL_FULL_ACCESS`: с токеном «только чтение» или на
 *   копилке робот не выставит заявку;
 * - для песочницы токен не должен давать полного доступа к реальному счёту (проверка на боевом контуре): иначе
 *   боевой токен ушёл бы в песочницу, куда допускаются и роботы без проверки TLS;
 * - 401, 403 и токен не по форме — токен отклонён; прочие 4xx — ошибка нашего запроса, она не выдаётся за отказ токена;
 * - недоступность — `TradingAccountsUnavailableError`: сценарий ничего не сохраняет.
 */
export class TInvestTradingAccounts implements TradingAccounts {
  constructor(private readonly client: TInvestClient) {}

  async check(token: string, mode: TradingMode, accountId: string): Promise<AccountCheck> {
    const listed = await this.accounts(mode, token)
    if (listed === 'REJECTED') return { ok: false, reason: 'TOKEN_REJECTED' }

    const account = listed.find((candidate) => candidate.id === accountId)
    if (mode === 'live') {
      if (account?.status !== 'ACCOUNT_STATUS_OPEN') return { ok: false, reason: 'ACCOUNT_NOT_FOUND' }
      if (!TRADABLE.has(account.type)) return { ok: false, reason: 'ACCOUNT_NOT_TRADABLE' }
      if (account.accessLevel !== 'ACCOUNT_ACCESS_LEVEL_FULL_ACCESS') return { ok: false, reason: 'READ_ONLY' }
      return { ok: true }
    }

    if (!account || account.status === 'ACCOUNT_STATUS_CLOSED') return { ok: false, reason: 'ACCOUNT_NOT_FOUND' }
    // Песочница — для роботов без проверки TLS тоже: токен с полным доступом к реальному счёту здесь не хранится
    const real = await this.accounts('live', token)
    const fullAccess = (candidate: { status: string; accessLevel: string }) =>
      candidate.status === 'ACCOUNT_STATUS_OPEN' && candidate.accessLevel === 'ACCOUNT_ACCESS_LEVEL_FULL_ACCESS'
    if (real !== 'REJECTED' && real.some(fullAccess)) {
      return { ok: false, reason: 'LIVE_TOKEN_IN_SANDBOX' }
    }

    return { ok: true }
  }

  /** Счета токена на контуре; `REJECTED` — токен не принят (401, 403, не годится по форме) */
  private async accounts(mode: TradingMode, token: string): Promise<Awaited<ReturnType<TInvestClient['accounts']>> | 'REJECTED'> {
    try {
      return await this.client.accounts(mode, token)
    } catch (error) {
      if (error instanceof TInvestUnauthenticatedError || error instanceof TInvestTokenFormatError) return 'REJECTED'
      if (error instanceof TInvestRejectedError && error.status === 403) return 'REJECTED'
      // Прочие 4xx — ошибка нашего запроса, а не токена: оператору не говорим «токен отклонён»
      if (error instanceof TInvestUnavailableError || error instanceof TInvestRejectedError) {
        throw new TradingAccountsUnavailableError(error.message, { cause: error })
      }
      throw error
    }
  }
}

/** Счета, где робот может выставлять заявки: брокерский и ИИС (копилка, фонд, дебетовый — нет) */
const TRADABLE = new Set(['ACCOUNT_TYPE_TINKOFF', 'ACCOUNT_TYPE_TINKOFF_IIS'])

/** Проверка выключена (`TINVEST_VERIFY_TOKENS=false`): разработка без сети и тесты. Боевой режим тогда закрыт */
export class DisabledTradingAccounts implements TradingAccounts {
  async check(): Promise<AccountCheck> {
    return { ok: false, reason: 'DISABLED' }
  }
}
