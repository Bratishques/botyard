import { Inject, Injectable } from '@nestjs/common'
import { AuditLog } from '../../../shared/audit/audit'
import { SecretBox, secretContext, secretHint } from '../../../shared/crypto/secret-box'
import { UnitOfWork } from '../../../shared/database/unit-of-work'
import {
  CUSTOMER_REPOSITORY,
  type Customer,
  type CustomerChanges,
  CustomerError,
  CustomerErrorCode,
  type CustomerRepository,
  CustomerStatus,
  modeOf,
  normalizeAccountId,
  normalizeCustomerName,
  type TradingMode,
} from '../domain/customer'

/** Контекст токена: клиент и режим. Токен песочницы не откроется как боевой и наоборот */
function tokenContext(customerId: string, mode: TradingMode) {
  return secretContext('customer', customerId, 'tinvest_token', mode)
}

/**
 * Сценарии клиентов. Изменения — условной записью по версии, аудит — в той же транзакции.
 *
 * Боевой режим — отдельное действие: новый боевой токен и подтверждение именем клиента, как при удалении
 * репозитория на GitHub. Роботы клиента в боевом режиме торгуют настоящими деньгами — случайный клик
 * не должен туда переводить.
 */
@Injectable()
export class CustomerUseCases {
  constructor(
    @Inject(CUSTOMER_REPOSITORY) private readonly repository: CustomerRepository,
    private readonly box: SecretBox,
    private readonly unitOfWork: UnitOfWork,
    private readonly audit: AuditLog,
  ) {}

  list(): Promise<Customer[]> {
    return this.repository.list()
  }

  async get(id: string): Promise<Customer> {
    return (await this.repository.findById(id)) ?? notFound(id)
  }

  /** Токен в открытом виде — только для передачи роботу при развёртывании (этап 2, шаг 3) */
  async revealToken(customer: Customer): Promise<string> {
    return this.box.open(customer.tokenSealed, tokenContext(customer.id, modeOf(customer)))
  }

  async create(input: { name: string; accountId: string; token: string }, actor: string): Promise<Customer> {
    const name = normalizeCustomerName(input.name)
    const accountId = normalizeAccountId(input.accountId)
    const id = Bun.randomUUIDv7()
    const tokenSealed = await this.box.seal(input.token, tokenContext(id, 'sandbox'))
    const tokenHint = secretHint(input.token)

    return this.unitOfWork.run(async () => {
      const created = await this.repository.insert({ id, name, accountId, tokenSealed, tokenHint })
      await this.audit.record({
        actor,
        action: 'customer.created',
        targetType: 'customer',
        targetId: id,
        payload: { name, accountId, tokenHint, version: created.version },
      })

      return created
    })
  }

  /**
   * Правка имени и счёта. Сменить счёт боевого клиента — значит направить его роботов торговать другим
   * счётом настоящими деньгами: это требует того же подтверждения именем, что и переход в боевой режим.
   */
  async update(
    id: string,
    input: { version: number; name?: string; accountId?: string; confirmName?: string },
    actor: string,
  ): Promise<Customer> {
    const current = await this.active(id, input.version)
    const changes: { -readonly [K in keyof CustomerChanges]: CustomerChanges[K] } = {}
    if (input.name !== undefined && normalizeCustomerName(input.name) !== current.name) changes.name = normalizeCustomerName(input.name)
    if (input.accountId !== undefined && normalizeAccountId(input.accountId) !== current.accountId) {
      if (!current.sandbox) confirmLive(current, input.confirmName)
      changes.accountId = normalizeAccountId(input.accountId)
    }
    if (Object.keys(changes).length === 0) return current

    // Смена счёта боевого клиента — отдельное событие с прежним и новым счётом: по аудиту должно быть видно,
    // куда направили роботов, торгующих настоящими деньгами
    const accountChange = changes.accountId === undefined ? {} : { accountId: { from: current.accountId, to: changes.accountId } }
    const action = changes.accountId !== undefined && !current.sandbox ? 'customer.account_changed' : 'customer.updated'

    return this.write(id, input.version, changes, actor, action, { fields: Object.keys(changes), ...accountChange })
  }

  /** Новый токен того же режима */
  async rotateToken(id: string, input: { version: number; token: string }, actor: string): Promise<Customer> {
    const current = await this.active(id, input.version)
    const tokenSealed = await this.box.seal(input.token, tokenContext(id, modeOf(current)))

    return this.write(id, input.version, { tokenSealed, tokenHint: secretHint(input.token) }, actor, 'customer.token_rotated', {
      mode: modeOf(current),
    })
  }

  /**
   * Перевод в боевой режим: боевой токен, боевой счёт и подтверждение точным именем клиента. Счета
   * песочницы и боевые — разные, поэтому счёт меняется вместе с режимом. Токен песочницы не переносится —
   * его конверт привязан к режиму и в боевом не откроется.
   */
  async goLive(
    id: string,
    input: { version: number; token: string; accountId: string; confirmName: string },
    actor: string,
  ): Promise<Customer> {
    const current = await this.active(id, input.version)
    if (!current.sandbox) throw new CustomerError(CustomerErrorCode.ALREADY_IN_MODE, 'customer is already live')
    confirmLive(current, input.confirmName)
    const accountId = normalizeAccountId(input.accountId)
    const tokenSealed = await this.box.seal(input.token, tokenContext(id, 'live'))

    return this.write(
      id,
      input.version,
      { sandbox: false, accountId, tokenSealed, tokenHint: secretHint(input.token) },
      actor,
      'customer.live_enabled',
      { accountId: { from: current.accountId, to: accountId } },
    )
  }

  /** Возврат в песочницу — с токеном и счётом песочницы: боевые в песочнице не нужны и не хранятся */
  async goSandbox(id: string, input: { version: number; token: string; accountId: string }, actor: string): Promise<Customer> {
    const current = await this.active(id, input.version)
    if (current.sandbox) throw new CustomerError(CustomerErrorCode.ALREADY_IN_MODE, 'customer is already in the sandbox')
    const accountId = normalizeAccountId(input.accountId)
    const tokenSealed = await this.box.seal(input.token, tokenContext(id, 'sandbox'))

    return this.write(
      id,
      input.version,
      { sandbox: true, accountId, tokenSealed, tokenHint: secretHint(input.token) },
      actor,
      'customer.sandbox_enabled',
      { accountId: { from: current.accountId, to: accountId } },
    )
  }

  /**
   * Архивация. Повтор после обрыва (та же или более ранняя версия, клиент уже в архиве) возвращает
   * клиента без изменений: архив — конечное состояние, перепутать его с чужой правкой нельзя.
   */
  async archive(id: string, version: number, actor: string): Promise<Customer> {
    const current = await this.get(id)
    if (current.status === CustomerStatus.ARCHIVED && version <= current.version) return current
    if (current.version !== version) throw versionConflict(id)

    return this.write(id, version, { status: CustomerStatus.ARCHIVED }, actor, 'customer.archived', {})
  }

  /** Клиент для изменения: существует, не в архиве, версия совпадает */
  private async active(id: string, version: number): Promise<Customer> {
    const current = await this.get(id)
    if (current.version !== version) throw versionConflict(id)
    if (current.status === CustomerStatus.ARCHIVED) throw new CustomerError(CustomerErrorCode.ARCHIVED, `customer ${id} is archived`)

    return current
  }

  private write(
    id: string,
    version: number,
    changes: CustomerChanges,
    actor: string,
    action: string,
    payload: Record<string, unknown>,
  ): Promise<Customer> {
    return this.unitOfWork.run(async () => {
      const updated = await this.repository.update(id, version, changes)
      if (!updated) {
        if (await this.repository.findById(id)) throw versionConflict(id)
        return notFound(id)
      }
      await this.audit.record({
        actor,
        action,
        targetType: 'customer',
        targetId: id,
        payload: { ...payload, version: updated.version, ...(changes.tokenHint && { tokenHint: changes.tokenHint }) },
      })

      return updated
    })
  }
}

function confirmLive(customer: Customer, confirmName: string | undefined): void {
  if (confirmName !== customer.name) {
    throw new CustomerError(CustomerErrorCode.LIVE_CONFIRMATION_REQUIRED, 'type the exact customer name to confirm live trading')
  }
}

function notFound(id: string): never {
  throw new CustomerError(CustomerErrorCode.NOT_FOUND, `customer ${id} is not found`)
}

function versionConflict(id: string): CustomerError {
  return new CustomerError(CustomerErrorCode.VERSION_CONFLICT, `customer ${id} was changed, reload and retry`)
}
