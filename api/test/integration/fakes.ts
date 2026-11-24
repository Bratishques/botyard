import type { TradingMode } from '../../src/modules/customers/domain/customer'
import {
  type AccountCheck,
  type TradingAccounts,
  TradingAccountsUnavailableError,
} from '../../src/modules/customers/domain/trading-accounts'
import type { DokployNotifications } from '../../src/modules/destinations/domain/webhook'

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

/** Уведомления Dokploy в памяти: запоминают последнюю регистрацию по имени */
export class FakeDokployNotifications implements DokployNotifications {
  readonly registered = new Map<string, { endpoint: string; headers: Record<string, string> }>()
  fail = false

  async upsertCustom(_baseUrl: string, _apiKey: string, notification: { name: string; endpoint: string; headers: Record<string, string> }) {
    if (this.fail) throw new Error('dokploy notification.createCustom: 503')
    this.registered.set(notification.name, { endpoint: notification.endpoint, headers: notification.headers })
    return `ntf-${notification.name.slice(-8)}`
  }
}
