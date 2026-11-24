import { describe, expect, test } from 'bun:test'
import accountsFixture from '../../../../test/fixtures/tinvest/accounts.json'
import unauthenticatedFixture from '../../../../test/fixtures/tinvest/unauthenticated.json'
import { DEFAULT_TINVEST_CLIENT, TInvestClient } from '../../../shared/tinvest/tinvest.client'
import { TradingAccountsUnavailableError } from '../domain/trading-accounts'
import { TInvestTradingAccounts } from './tinvest-trading-accounts'

type Reply = { status: number; body: unknown }

/** Брокер с ответами по контурам: `live` — UsersService/GetAccounts, `sandbox` — GetSandboxAccounts */
function broker(replies: { live?: Reply; sandbox?: Reply }): TInvestTradingAccounts {
  const fetch = Object.assign(
    async (input: string | URL | Request) => {
      const reply = (String(input).includes('UsersService') ? replies.live : replies.sandbox) ?? {
        status: 401,
        body: unauthenticatedFixture,
      }
      return Response.json(reply.body, { status: reply.status })
    },
    { preconnect: () => undefined },
  )
  return new TInvestTradingAccounts(
    new TInvestClient({ ...DEFAULT_TINVEST_CLIENT, ca: null, fetch, retry: { attempts: 1, baseDelayMs: 1, maxDelayMs: 1 } }),
  )
}

const accountsFrom = (status: number, body: unknown) => broker({ live: { status, body }, sandbox: { status, body } })
const listed = broker({ live: { status: 200, body: accountsFixture } })
/** Токен песочницы: на боевом контуре его не принимают */
const sandboxOnly = broker({ sandbox: { status: 200, body: accountsFixture } })

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
    expect(await sandboxOnly.check('t.x', 'sandbox', '2000000002')).toEqual({ ok: true })
    expect(await sandboxOnly.check('t.x', 'sandbox', '2000000004')).toEqual({ ok: true })
    expect(await sandboxOnly.check('t.x', 'sandbox', '2000000003')).toEqual({ ok: false, reason: 'ACCOUNT_NOT_FOUND' })
  })

  test('песочница: токен с полным доступом к реальному счёту не принимается; только чтение — можно', async () => {
    const both = broker({ sandbox: { status: 200, body: accountsFixture }, live: { status: 200, body: accountsFixture } })
    expect(await both.check('t.x', 'sandbox', '2000000001')).toEqual({ ok: false, reason: 'LIVE_TOKEN_IN_SANDBOX' })

    const readOnlyReal = broker({
      sandbox: { status: 200, body: accountsFixture },
      live: {
        status: 200,
        body: { accounts: [{ id: '1', status: 'ACCOUNT_STATUS_OPEN', accessLevel: 'ACCOUNT_ACCESS_LEVEL_READ_ONLY' }] },
      },
    })
    expect(await readOnlyReal.check('t.x', 'sandbox', '2000000001')).toEqual({ ok: true })
  })

  test('боевой режим: копилка и прочие счета без заявок — ACCOUNT_NOT_TRADABLE; токен не по форме — отклонён до запроса', async () => {
    const piggy = broker({
      live: {
        status: 200,
        body: {
          accounts: [
            { id: '7', type: 'ACCOUNT_TYPE_INVEST_BOX', status: 'ACCOUNT_STATUS_OPEN', accessLevel: 'ACCOUNT_ACCESS_LEVEL_FULL_ACCESS' },
          ],
        },
      },
    })
    expect(await piggy.check('t.x', 'live', '7')).toEqual({ ok: false, reason: 'ACCOUNT_NOT_TRADABLE' })
    expect(await listed.check('t.with space', 'live', '2000000001')).toEqual({ ok: false, reason: 'TOKEN_REJECTED' })
    expect(await listed.check('t.кириллица', 'live', '2000000001')).toEqual({ ok: false, reason: 'TOKEN_REJECTED' })
  })

  test('прочие 4xx — ошибка нашего запроса: недоступность, а не «токен отклонён»', async () => {
    await expect(accountsFrom(400, { code: 3, message: 'bad', description: '30001' }).check('t.x', 'live', '1')).rejects.toBeInstanceOf(
      TradingAccountsUnavailableError,
    )
    await expect(accountsFrom(408, {}).check('t.x', 'live', '1')).rejects.toBeInstanceOf(TradingAccountsUnavailableError)
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
