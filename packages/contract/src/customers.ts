import { z } from 'zod'
import { version } from './common'

// Токены T-Invest длинные (t.…); короче 16 — заведомо не токен, а подсказка открыла бы большую его долю.
// Печатные ASCII без пробелов: токен уходит в заголовок Authorization
const token = z
  .string()
  .trim()
  .min(16)
  .max(512)
  .regex(/^[\x21-\x7e]+$/, 'must be printable ASCII without spaces')
const accountId = z.string().max(100)
const name = z.string().max(200)

export const customerCreateSchema = z.object({ name, accountId, token }).strict()
export type CustomerCreateBody = z.infer<typeof customerCreateSchema>

export const customerUpdateSchema = z
  .object({ version, name: name.optional(), accountId: accountId.optional(), confirmName: name.optional() })
  .strict()
export type CustomerUpdateBody = z.infer<typeof customerUpdateSchema>

export const customerTokenSchema = z.object({ version, token }).strict()
export type CustomerTokenBody = z.infer<typeof customerTokenSchema>

/** Перевод в боевой режим: боевой токен и счёт, `confirmName` — точное имя клиента */
export const customerLiveSchema = z.object({ version, token, accountId, confirmName: name }).strict()
export type CustomerLiveBody = z.infer<typeof customerLiveSchema>

export const customerSandboxSchema = z.object({ version, token, accountId }).strict()
export type CustomerSandboxBody = z.infer<typeof customerSandboxSchema>

export type TradingMode = 'sandbox' | 'live'
export type CustomerStatus = 'ACTIVE' | 'ARCHIVED'

/** Клиент наружу: без конверта токена, только подсказка */
export interface CustomerView {
  id: string
  name: string
  accountId: string
  tokenHint: string
  mode: TradingMode
  status: CustomerStatus
  version: number
  createdAt: string
  updatedAt: string
}
