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
  /** Барьер внутри проверки: ответ брокера задерживается, пока не придут `participants` вызовов */
  private gate: { participants: number; arrived: number; open: () => void; opened: Promise<void> } | null = null

  holdUntil(participants: number): void {
    let open: () => void = () => {}
    const opened = new Promise<void>((resolve) => (open = resolve))
    this.gate = { participants, arrived: 0, open, opened }
  }

  release(): void {
    this.gate?.open()
    this.gate = null
  }

  async check(token: string, mode: TradingMode, accountId: string): Promise<AccountCheck> {
    this.asked.push({ mode, accountId })
    const gate = this.gate
    if (gate) {
      gate.arrived++
      if (gate.arrived >= gate.participants) gate.open()
      await Promise.race([gate.opened, Bun.sleep(2_000)])
    }
    if (this.down) throw new TradingAccountsUnavailableError('t-invest UsersService/GetAccounts: 503')
    return this.results.get(token) ?? { ok: true }
  }
}
