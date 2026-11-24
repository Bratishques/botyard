import { describe, expect, test } from 'bun:test'
import accountsFixture from '../../../../test/fixtures/tinvest/accounts.json'
import unauthenticatedFixture from '../../../../test/fixtures/tinvest/unauthenticated.json'
import { DEFAULT_TINVEST_CLIENT, TInvestClient } from '../../../shared/tinvest/tinvest.client'
import { TradingAccountsUnavailableError } from '../domain/trading-accounts'
import { TInvestTradingAccounts } from './tinvest-trading-accounts'

/** Брокер, который на любой запрос отвечает одним и тем же */
function accountsFrom(status: number, body: unknown): TInvestTradingAccounts {
  const fetch = Object.assign(async () => Response.json(body, { status }), { preconnect: () => undefined })
  return new TInvestTradingAccounts(
    new TInvestClient({ ...DEFAULT_TINVEST_CLIENT, ca: null, fetch, retry: { attempts: 1, baseDelayMs: 1, maxDelayMs: 1 } }),
  )
}

const listed = accountsFrom(200, accountsFixture)

describe('проверка счёта клиента в T-Invest', () => {
  test('боевой режим: открытый счёт с полным доступом — да; только чтение — READ_ONLY; закрытый и чужой — нет', async () => {
    expect(await listed.check('t.x', 'live', '2000000001')).toEqual({ ok: true })
    expect(await listed.check('t.x', 'live', '2000000002')).toEqual({ ok: false, reason: 'READ_ONLY' })
    expect(await listed.check('t.x', 'live', '2000000003')).toEqual({ ok: false, reason: 'ACCOUNT_NOT_FOUND' })
    expect(await listed.check('t.x', 'live', '9999999999')).toEqual({ ok: false, reason: 'ACCOUNT_NOT_FOUND' })
    // Без статуса (UNSPECIFIED) боевой счёт не принимается
    expect(await listed.check('t.x', 'live', '2000000004')).toEqual({ ok: false, reason: 'ACCOUNT_NOT_FOUND' })
  })

  test('песочница: уровень доступа не требуется, отклоняется только закрытый и отсутствующий счёт', async () => {
    expect(await listed.check('t.x', 'sandbox', '2000000002')).toEqual({ ok: true })
    expect(await listed.check('t.x', 'sandbox', '2000000004')).toEqual({ ok: true })
    expect(await listed.check('t.x', 'sandbox', '2000000003')).toEqual({ ok: false, reason: 'ACCOUNT_NOT_FOUND' })
  })

  test('токен отклонён (401, 403) — TOKEN_REJECTED; брокер недоступен — ошибка недоступности', async () => {
    expect(await accountsFrom(401, unauthenticatedFixture).check('t.x', 'live', '1')).toEqual({ ok: false, reason: 'TOKEN_REJECTED' })
    expect(
      await accountsFrom(403, { code: 7, message: 'Insufficient privileges', description: '40002' }).check('t.x', 'live', '1'),
    ).toEqual({
      ok: false,
      reason: 'TOKEN_REJECTED',
    })
    await expect(accountsFrom(503, {}).check('t.x', 'live', '1')).rejects.toBeInstanceOf(TradingAccountsUnavailableError)
  })
})
