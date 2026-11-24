import {
  TInvestClient,
  TInvestRejectedError,
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
 * - для боевого — `ACCOUNT_ACCESS_LEVEL_FULL_ACCESS`: с токеном «только чтение» робот не выставит заявку;
 * - 401 (40003) — токен отклонён; прочие отказы брокера — тоже отказ проверки, а не «временно»;
 * - недоступность — `TradingAccountsUnavailableError`: сценарий ничего не сохраняет.
 */
export class TInvestTradingAccounts implements TradingAccounts {
  constructor(private readonly client: TInvestClient) {}

  async check(token: string, mode: TradingMode, accountId: string): Promise<AccountCheck> {
    let accounts: Awaited<ReturnType<TInvestClient['accounts']>>
    try {
      accounts = await this.client.accounts(mode, token)
    } catch (error) {
      if (error instanceof TInvestUnauthenticatedError) return { ok: false, reason: 'TOKEN_REJECTED' }
      // 403 и прочие 4xx на чтение своих счетов — токен без нужных прав для этого контура
      if (error instanceof TInvestRejectedError) return { ok: false, reason: 'TOKEN_REJECTED' }
      if (error instanceof TInvestUnavailableError) throw new TradingAccountsUnavailableError(error.message, { cause: error })
      throw error
    }

    const account = accounts.find((candidate) => candidate.id === accountId)
    const usable =
      mode === 'live' ? account?.status === 'ACCOUNT_STATUS_OPEN' : account !== undefined && account.status !== 'ACCOUNT_STATUS_CLOSED'
    if (!account || !usable) return { ok: false, reason: 'ACCOUNT_NOT_FOUND' }
    if (mode === 'live' && account.accessLevel !== 'ACCOUNT_ACCESS_LEVEL_FULL_ACCESS') return { ok: false, reason: 'READ_ONLY' }

    return { ok: true }
  }
}

/** Проверка выключена (`TINVEST_VERIFY_TOKENS=false`): разработка без сети и тесты. Боевой режим тогда закрыт */
export class DisabledTradingAccounts implements TradingAccounts {
  async check(): Promise<AccountCheck> {
    return { ok: false, reason: 'DISABLED' }
  }
}
