/**
 * Клиент — владелец брокерского счёта T-Invest, для которого разворачиваются роботы.
 *
 * Токен T-Invest в домене открытым текстом не живёт: только конверт и подсказка. Конверт привязан к
 * режиму: токен песочницы не откроется как боевой. Переход в боевой режим — отдельное действие с новым
 * токеном и подтверждением (docs/architecture.md, «Безопасность»).
 */
export const CustomerStatus = { ACTIVE: 'ACTIVE', ARCHIVED: 'ARCHIVED' } as const
export type CustomerStatus = (typeof CustomerStatus)[keyof typeof CustomerStatus]

export type TradingMode = 'sandbox' | 'live'

export interface Customer {
  readonly id: string
  readonly name: string
  readonly accountId: string
  readonly tokenSealed: Uint8Array
  readonly tokenHint: string
  readonly sandbox: boolean
  readonly status: CustomerStatus
  readonly version: number
  readonly createdAt: Date
  readonly updatedAt: Date
}

export const CustomerErrorCode = {
  NOT_FOUND: 'CUSTOMER_NOT_FOUND',
  NAME_TAKEN: 'CUSTOMER_NAME_TAKEN',
  VERSION_CONFLICT: 'CUSTOMER_VERSION_CONFLICT',
  INVALID_NAME: 'CUSTOMER_INVALID_NAME',
  INVALID_ACCOUNT: 'CUSTOMER_INVALID_ACCOUNT',
  LIVE_CONFIRMATION_REQUIRED: 'CUSTOMER_LIVE_CONFIRMATION_REQUIRED',
  ALREADY_IN_MODE: 'CUSTOMER_ALREADY_IN_MODE',
  ARCHIVED: 'CUSTOMER_ARCHIVED',
} as const
export type CustomerErrorCode = (typeof CustomerErrorCode)[keyof typeof CustomerErrorCode]

export class CustomerError extends Error {
  override readonly name = 'CustomerError'

  constructor(
    readonly code: CustomerErrorCode,
    message: string,
  ) {
    super(message)
  }
}

export function modeOf(customer: Pick<Customer, 'sandbox'>): TradingMode {
  return customer.sandbox ? 'sandbox' : 'live'
}

export function normalizeCustomerName(input: string): string {
  const name = input.trim()
  if (name.length < 1 || name.length > 120) throw new CustomerError(CustomerErrorCode.INVALID_NAME, 'name must be 1..120 characters')

  return name
}

/** Номер счёта T-Invest: латиница, цифры, `-` и `_` (так же проверяет CHECK в базе) */
export function normalizeAccountId(input: string): string {
  const accountId = input.trim()
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(accountId)) throw new CustomerError(CustomerErrorCode.INVALID_ACCOUNT, 'account id is invalid')

  return accountId
}

export interface NewCustomer {
  readonly id: string
  readonly name: string
  readonly accountId: string
  readonly tokenSealed: Uint8Array
  readonly tokenHint: string
}

export interface CustomerChanges {
  readonly name?: string
  readonly accountId?: string
  readonly tokenSealed?: Uint8Array
  readonly tokenHint?: string
  readonly sandbox?: boolean
  readonly status?: CustomerStatus
}

/** Хранилище клиентов. Изменения — только условные записи по версии; `null` — условие не выполнено */
export interface CustomerRepository {
  /** Имя занято — `CustomerError(NAME_TAKEN)` */
  insert(customer: NewCustomer): Promise<Customer>
  findById(id: string): Promise<Customer | null>
  list(): Promise<Customer[]>
  update(id: string, expectedVersion: number, changes: CustomerChanges): Promise<Customer | null>
}

export const CUSTOMER_REPOSITORY = Symbol('CUSTOMER_REPOSITORY')
