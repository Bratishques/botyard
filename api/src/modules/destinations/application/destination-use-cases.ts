import { Inject, Injectable } from '@nestjs/common'
import { AuditLog } from '../../../shared/audit/audit'
import { APP_CONFIG, type AppConfig } from '../../../shared/config/config'
import { UnitOfWork } from '../../../shared/database/unit-of-work'
import {
  type Destination,
  DestinationError,
  DestinationErrorCode,
  DestinationStatus,
  normalizeBaseUrl,
  normalizeName,
} from '../domain/destination'
import {
  DESTINATION_REPOSITORY,
  type DestinationChanges,
  DestinationConflict,
  type DestinationRepository,
  DOKPLOY_CATALOG,
  type DokployCatalog,
} from '../domain/ports'
import { DestinationSecrets } from './destination-secrets'
import { DestinationWebhooks } from './destination-webhooks'
import { toDestinationError, verifyTarget } from './verify-target'

export interface CreateDestinationInput {
  readonly name: string
  readonly baseUrl: string
  readonly apiKey: string
  readonly environmentId: string
  readonly serverId: string | null
}

export interface UpdateDestinationInput {
  readonly version: number
  readonly name?: string
  readonly baseUrl?: string
  readonly apiKey?: string
  readonly environmentId?: string
  readonly serverId?: string | null
}

/**
 * Сценарии назначений. Общий порядок у изменяющих:
 *
 *   прочитать ─► проверить цель в Dokploy (вне транзакции) ─► зашифровать ─► условная запись + аудит (одна транзакция)
 *
 * Условие записи — версия, прочитанная в начале. Если между чтением и записью назначение
 * изменили, проверка Dokploy относилась к устаревшим данным: запись не проходит, оператор
 * получает 409 и повторяет со свежей версией.
 */
@Injectable()
export class DestinationUseCases {
  constructor(
    @Inject(DESTINATION_REPOSITORY) private readonly repository: DestinationRepository,
    @Inject(DOKPLOY_CATALOG) private readonly catalog: DokployCatalog,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly secrets: DestinationSecrets,
    private readonly unitOfWork: UnitOfWork,
    private readonly audit: AuditLog,
    private readonly webhooks: DestinationWebhooks,
  ) {}

  list(): Promise<Destination[]> {
    return this.repository.list()
  }

  async get(id: string): Promise<Destination> {
    return (await this.repository.findById(id)) ?? notFound(id)
  }

  /**
   * Назначение с открытым ключом — для воркера саги. Ключ открывается контекстом с `base_url`: подмена
   * адреса в базе не отправит его на чужой хост. Живёт только на время шага, не логируется.
   */
  async connection(id: string): Promise<{ destination: Destination; apiKey: string }> {
    const destination = await this.get(id)

    return { destination, apiKey: await this.secrets.open(destination.id, destination.baseUrl, destination.apiKeySealed) }
  }

  /** Что есть в Dokploy по адресу и ключу — для выбора окружения в форме до сохранения */
  async preview(
    baseUrlInput: string,
    apiKey: string,
  ): Promise<{
    baseUrl: string
    environments: { projectId: string; environmentId: string; name: string }[]
    servers: { serverId: string; name: string }[]
  }> {
    const baseUrl = this.normalizeUrl(baseUrlInput)
    try {
      const [environments, servers] = await Promise.all([this.catalog.environments(baseUrl, apiKey), this.catalog.servers(baseUrl, apiKey)])
      return { baseUrl, environments, servers }
    } catch (error) {
      throw toDestinationError(error)
    }
  }

  async create(input: CreateDestinationInput, actor: string): Promise<Destination> {
    const name = normalizeName(input.name)
    const baseUrl = this.normalizeUrl(input.baseUrl)
    const { projectId } = await verifyTarget(this.catalog, { ...input, baseUrl })

    const id = Bun.randomUUIDv7()
    const { sealed, hint } = await this.secrets.seal(id, baseUrl, input.apiKey)

    const created = await this.unitOfWork.run(async () => {
      const created = await this.repository
        .insert({
          id,
          name,
          baseUrl,
          apiKeySealed: sealed,
          apiKeyHint: hint,
          projectId,
          environmentId: input.environmentId,
          serverId: input.serverId,
        })
        .catch(rethrowConflict)
      await this.audit.record({
        actor,
        action: 'destination.created',
        targetType: 'destination',
        targetId: id,
        payload: { name, baseUrl, environmentId: input.environmentId, serverId: input.serverId, apiKeyHint: hint },
      })

      return created
    })
    // Вебхук Dokploy — после записи и вне транзакции; неудача не отменяет создание (см. DestinationWebhooks)
    await this.webhooks.register(created, input.apiKey)

    return created
  }

  async update(id: string, input: UpdateDestinationInput, actor: string): Promise<Destination> {
    const current = await this.get(id)
    if (current.version !== input.version) throw versionConflict(id)

    const baseUrl = input.baseUrl === undefined ? current.baseUrl : this.normalizeUrl(input.baseUrl)
    const baseUrlChanged = baseUrl !== current.baseUrl
    // Конверт привязан к адресу: старый ключ для нового адреса не откроется, а переносить его молча нельзя
    if (baseUrlChanged && input.apiKey === undefined) {
      throw new DestinationError(DestinationErrorCode.KEY_REQUIRED, 'changing the base url requires the api key')
    }

    const environmentId = input.environmentId ?? current.environmentId
    const serverId = input.serverId === undefined ? current.serverId : input.serverId
    const targetChanged =
      baseUrlChanged || input.apiKey !== undefined || environmentId !== current.environmentId || serverId !== current.serverId

    const changes: { -readonly [K in keyof DestinationChanges]: DestinationChanges[K] } = {}
    if (input.name !== undefined && normalizeName(input.name) !== current.name) changes.name = normalizeName(input.name)

    if (targetChanged) {
      const apiKey = input.apiKey ?? (await this.secrets.open(current.id, current.baseUrl, current.apiKeySealed))
      const { projectId } = await verifyTarget(this.catalog, { baseUrl, apiKey, environmentId, serverId })
      if (baseUrl !== current.baseUrl) changes.baseUrl = baseUrl
      if (projectId !== current.projectId) changes.projectId = projectId
      if (environmentId !== current.environmentId) changes.environmentId = environmentId
      if (serverId !== current.serverId) changes.serverId = serverId
      // Цель только что проверена — связь есть. Но выключение — решение оператора: правка его не снимает,
      // включают только явным enable. Условие держит версия: статус прочитан вместе с ней
      const staleUnreachable = current.status === DestinationStatus.UNREACHABLE || current.lastError !== null
      if (current.status !== DestinationStatus.DISABLED && staleUnreachable) {
        Object.assign(changes, { status: DestinationStatus.ACTIVE, lastError: null })
      }
      if (input.apiKey !== undefined) {
        const { sealed, hint } = await this.secrets.seal(current.id, baseUrl, input.apiKey)
        Object.assign(changes, { apiKeySealed: sealed, apiKeyHint: hint })
      }
    }
    if (Object.keys(changes).length === 0) return current

    // Новый ключ должен видеть приложения роботов этого назначения: Dokploy показывает пользователю только
    // его приложения, и сага с ключом другого пользователя не нашла бы роботов — создала бы второго
    // при redeploy, а удаление сочло бы робота удалённым
    const relocated = changes.baseUrl !== undefined || changes.environmentId !== undefined || changes.serverId !== undefined
    // Переезд с роботами запрещён и так (ниже, под блокировкой) — видимость для него не проверяется
    const keyChanged = input.apiKey !== undefined && !relocated
    let visible: Set<string> | null = null
    if (keyChanged && input.apiKey !== undefined && (await this.repository.liveApplicationIds(id)).length > 0) {
      visible = await this.catalog.applicationIds(baseUrl, input.apiKey, environmentId).catch((error: unknown) => {
        throw toDestinationError(error)
      })
      assertVisible(await this.repository.liveApplicationIds(id), visible)
    }

    const updated = await this.unitOfWork.run(async () => {
      // Роботы назначения живут по прежнему адресу и в прежнем окружении: сага ищет их там. Переезд назначения
      // с живыми роботами оставил бы их работать без управления, а удаление сочло бы их удалёнными
      const live = await this.repository.hasLiveDeployments(id)
      if (relocated && live) {
        throw new DestinationError(
          DestinationErrorCode.HAS_DEPLOYMENTS,
          'delete the deployments on this destination before changing its address, environment or server',
        )
      }
      // Под блокировкой назначения: новые развёртывания не появятся, а приложение, созданное прежним ключом
      // после проверки, — повод проверить заново
      if (keyChanged && live) assertVisible(await this.repository.liveApplicationIds(id), visible ?? new Set())
      const updated =
        (await this.repository.update(id, input.version, changes).catch(rethrowConflict)) ?? (await this.conflictOrMissing(id))
      await this.audit.record({
        actor,
        action: 'destination.updated',
        targetType: 'destination',
        targetId: id,
        payload: { fields: Object.keys(changes).filter((field) => field !== 'apiKeySealed'), version: updated.version },
      })

      return updated
    })

    // Другой адрес, окружение или ключ — уведомление в Dokploy регистрируется заново (повторяемо; неудача только
    // записывается). Иначе вебхук остался бы в прежнем Dokploy или с ключом, который больше не действует
    if (targetChanged) {
      await this.webhooks.register(updated, input.apiKey ?? (() => this.secrets.open(updated.id, updated.baseUrl, updated.apiKeySealed)), {
        rotateSecret: baseUrlChanged,
      })
    }

    return updated
  }

  /** Включение и выключение. Повтор (уже в нужном статусе) — без изменений: версия не растёт, аудита нет */
  async setEnabled(id: string, version: number, enabled: boolean, actor: string): Promise<Destination> {
    const status = enabled ? DestinationStatus.ACTIVE : DestinationStatus.DISABLED

    return this.unitOfWork.run(async () => {
      const changed = await this.repository.update(id, version, { status, ...(enabled && { lastError: null }) }, { unlessStatus: status })
      if (!changed) {
        const current = await this.repository.findById(id)
        if (current?.version === version && current.status === status) return current
        return this.conflictOrMissing(id)
      }
      const updated = changed
      await this.audit.record({
        actor,
        action: enabled ? 'destination.enabled' : 'destination.disabled',
        targetType: 'destination',
        targetId: id,
        payload: { version: updated.version },
      })

      return updated
    })
  }

  /**
   * Проверка связи. Результат записывается, только если с момента чтения назначение не меняли
   * и не выключили: иначе ответ на старый ключ затёр бы свежую правку. Тогда возвращается текущее
   * состояние без изменений.
   */
  async check(id: string, actor: string): Promise<Destination> {
    const current = await this.get(id)
    if (current.status === DestinationStatus.DISABLED) return current

    let error: string | null = null
    try {
      const apiKey = await this.secrets.open(current.id, current.baseUrl, current.apiKeySealed)
      await verifyTarget(this.catalog, {
        baseUrl: current.baseUrl,
        apiKey,
        environmentId: current.environmentId,
        serverId: current.serverId,
      })
      // Связь есть — заодно убедиться, что вебхук зарегистрирован (повторяемо; неудача только записывается)
      await this.webhooks.register(current, apiKey)
    } catch (caught) {
      if (!(caught instanceof DestinationError)) throw caught
      error = `${caught.code}: ${caught.message}`
    }

    // Момент наблюдения, а не записи: из двух параллельных проверок остаётся более свежая по ответу Dokploy
    const observedAt = new Date()
    const status = error === null ? DestinationStatus.ACTIVE : DestinationStatus.UNREACHABLE
    return this.unitOfWork.run(async () => {
      const recorded = await this.repository.recordCheck(id, current.version, { status, error, checkedAt: observedAt })
      if (!recorded) return this.get(id)

      await this.audit.record({ actor, action: 'destination.checked', targetType: 'destination', targetId: id, payload: { status, error } })
      return recorded
    })
  }

  private normalizeUrl(input: string): string {
    return normalizeBaseUrl(input, { allowHttp: this.config.DESTINATIONS_ALLOW_HTTP })
  }

  /** Условная запись не прошла: назначение изменили (409) или его уже нет (404) */
  private async conflictOrMissing(id: string): Promise<never> {
    if (await this.repository.findById(id)) throw versionConflict(id)
    return notFound(id)
  }
}

function notFound(id: string): never {
  throw new DestinationError(DestinationErrorCode.NOT_FOUND, `destination ${id} is not found`)
}

function versionConflict(id: string): DestinationError {
  return new DestinationError(DestinationErrorCode.VERSION_CONFLICT, `destination ${id} was changed, reload and retry`)
}

function assertVisible(appIds: readonly string[], visible: ReadonlySet<string>): void {
  const hidden = appIds.filter((appId) => !visible.has(appId))
  if (hidden.length > 0) {
    throw new DestinationError(
      DestinationErrorCode.KEY_CANNOT_SEE_DEPLOYMENTS,
      `the new api key does not see ${hidden.length} application(s) of this destination's deployments: use a key of the same Dokploy user`,
    )
  }
}

function rethrowConflict(error: unknown): never {
  if (error instanceof DestinationConflict) {
    throw error.field === 'name'
      ? new DestinationError(DestinationErrorCode.NAME_TAKEN, 'destination name is taken')
      : new DestinationError(DestinationErrorCode.TARGET_TAKEN, 'this dokploy environment is already a destination')
  }
  throw error
}
