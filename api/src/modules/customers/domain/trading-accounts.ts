import type { TradingMode } from './customer'

/**
 * Итог проверки токена и счёта клиента у брокера.
 * - `ok` — токен действует в этом режиме, счёт есть, открыт, и (для боевого) токен даёт полный доступ к нему;
 * - `TOKEN_REJECTED` — токен не найден или не активен;
 * - `ACCOUNT_NOT_FOUND` — у токена нет такого счёта в этом режиме (или он не открыт);
 * - `READ_ONLY` — к счёту есть только чтение: робот не сможет выставлять заявки;
 * - `DISABLED` — проверка выключена конфигурацией (только разработка и тесты).
 */
export type AccountCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'TOKEN_REJECTED' | 'ACCOUNT_NOT_FOUND' | 'READ_ONLY' | 'DISABLED' }

/** Брокер недоступен (сеть, таймаут, 5xx, лимит): проверить не удалось — сохранять нельзя */
export class TradingAccountsUnavailableError extends Error {
  override readonly name = 'TradingAccountsUnavailableError'
}

/** Счета клиента у брокера (T-Invest) */
export interface TradingAccounts {
  check(token: string, mode: TradingMode, accountId: string): Promise<AccountCheck>
}

export const TRADING_ACCOUNTS = Symbol('TRADING_ACCOUNTS')
