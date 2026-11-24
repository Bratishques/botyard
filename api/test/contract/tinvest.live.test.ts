import { describe, expect, test } from 'bun:test'
import { TInvestTradingAccounts } from '../../src/modules/customers/infrastructure/tinvest-trading-accounts'
import { TInvestClient } from '../../src/shared/tinvest/tinvest.client'

/**
 * Контракт с живым T-Invest API (`bun run test:contract`). Запускается при `TINVEST_CONTRACT=1`.
 * Без токена проверяется отказ заведомо фиктивному токену — этого достаточно, чтобы проверить адреса, пути
 * методов, форму ошибки и TLS с корнем Минцифры. С `TINVEST_TEST_SANDBOX_TOKEN` и `TINVEST_TEST_SANDBOX_ACCOUNT`
 * — и успешный путь в песочнице. Токен берётся из окружения и никуда не печатается.
 */
const live = describe.skipIf(process.env.TINVEST_CONTRACT !== '1')
const sandboxToken = process.env.TINVEST_TEST_SANDBOX_TOKEN
const sandboxAccount = process.env.TINVEST_TEST_SANDBOX_ACCOUNT

live('T-Invest API (живой)', () => {
  const accounts = new TInvestTradingAccounts(new TInvestClient())

  test.each(['live', 'sandbox'] as const)('фиктивный токен в режиме %s — TOKEN_REJECTED', async (mode) => {
    expect(await accounts.check('t.botyard-contract-fake-token', mode, '2000000001')).toEqual({ ok: false, reason: 'TOKEN_REJECTED' })
  })

  test.skipIf(!sandboxToken || !sandboxAccount)('токен песочницы видит свой счёт', async () => {
    expect(await accounts.check(sandboxToken ?? '', 'sandbox', sandboxAccount ?? '')).toEqual({ ok: true })
    expect(await accounts.check(sandboxToken ?? '', 'sandbox', 'not-my-account')).toEqual({ ok: false, reason: 'ACCOUNT_NOT_FOUND' })
  })
})
