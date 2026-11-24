import type { TradingMode } from '../../src/modules/customers/domain/customer'
import {
  type AccountCheck,
  type TradingAccounts,
  TradingAccountsUnavailableError,
} from '../../src/modules/customers/domain/trading-accounts'

/**
 * Брокер в памяти: по умолчанию любой токен действует с любым счётом. `results` — исход для токена,
 * `down` — брокер недоступен. Запоминает, что спрашивали (без токена: только режим и счёт).
 */
export class FakeTradingAccounts implements TradingAccounts {
  readonly results = new Map<string, AccountCheck>()
  readonly asked: { mode: TradingMode; accountId: string }[] = []
  down = false

  async check(token: string, mode: TradingMode, accountId: string): Promise<AccountCheck> {
    this.asked.push({ mode, accountId })
    if (this.down) throw new TradingAccountsUnavailableError('t-invest UsersService/GetAccounts: 503')
    return this.results.get(token) ?? { ok: true }
  }
}
