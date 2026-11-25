import { randomBytes, timingSafeEqual } from 'node:crypto'
import { Inject, Injectable, Logger } from '@nestjs/common'
import { APP_CONFIG, type AppConfig } from '../../../shared/config/config'
import { SecretBox, secretContext } from '../../../shared/crypto/secret-box'
import type { Destination } from '../domain/destination'
import {
  DESTINATION_WEBHOOK_REPOSITORY,
  type DestinationWebhookRepository,
  DOKPLOY_NOTIFICATIONS,
  type DokployNotifications,
  WEBHOOK_TOKEN_HEADER,
} from '../domain/webhook'

/** Секрет вебхука уходит только в Dokploy этого назначения; привязан к записи назначения */
const secretOf = (destinationId: string) => secretContext('destination', destinationId, 'webhook_secret')

/**
 * Вебхук Dokploy на назначении: регистрация custom-уведомления и проверка секрета входящих вызовов.
 *
 * - Регистрация — «лучшее усилие»: при создании и проверке назначения, вне транзакции. Неудача записывается
 *   и не ломает сценарий — исход деплоя всё равно узнаётся опросом.
 * - Без `PUBLIC_API_URL` регистрации нет: Dokploy некуда слать.
 * - Секрет — 32 случайных байта на назначение, в базе — только конверт; сравнение — за постоянное время.
 */
@Injectable()
export class DestinationWebhooks {
  private readonly logger = new Logger(DestinationWebhooks.name)

  constructor(
    @Inject(DESTINATION_WEBHOOK_REPOSITORY) private readonly repository: DestinationWebhookRepository,
    @Inject(DOKPLOY_NOTIFICATIONS) private readonly notifications: DokployNotifications,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly box: SecretBox,
  ) {}

  /** Адрес вебхука назначения или `null`, если api снаружи не виден */
  endpointOf(destinationId: string): string | null {
    return this.config.PUBLIC_API_URL ? `${this.config.PUBLIC_API_URL}/webhooks/dokploy/${destinationId}` : null
  }

  /**
   * `apiKey` — значение или поставщик: расшифровка ключа тоже внутри «лучшего усилия». `rotateSecret` — назначение
   * переехало на другой Dokploy: уведомление, оставшееся в прежнем, со старым секретом больше не принимается
   */
  async register(
    destination: Pick<Destination, 'id' | 'baseUrl'>,
    apiKey: string | (() => Promise<string>),
    options: { rotateSecret?: boolean } = {},
  ): Promise<void> {
    const endpoint = this.endpointOf(destination.id)
    if (!endpoint) return

    // Целиком «лучшее усилие»: сбой базы, шифрования или Dokploy здесь не должен ронять создание, правку или проверку
    try {
      // Новый секрет — отдельной записью до регистрации: даже если Dokploy её не примет, прежний секрет уже не действует
      const fresh = await this.box.seal(randomBytes(32).toString('base64url'), secretOf(destination.id))
      if (options.rotateSecret) await this.repository.rotate(destination.id, fresh)
      // Запись с секретом — до блокировки и отдельно (атомарный upsert): откат неудачной регистрации её не уносит,
      // и неудаче есть куда записаться
      else await this.repository.ensure(destination.id, fresh)
      await this.repository.serialized(destination.id, () => this.registerLocked(destination, endpoint, apiKey))
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'registration failed'
      this.logger.warn({ destinationId: destination.id, reason }, 'dokploy webhook registration failed, polling stays in charge')
      await this.repository.recordFailed(destination.id, reason).catch(() => undefined)
    }
  }

  private async registerLocked(
    destination: Pick<Destination, 'id' | 'baseUrl'>,
    endpoint: string,
    apiKey: string | (() => Promise<string>),
  ): Promise<void> {
    const key = typeof apiKey === 'string' ? apiKey : await apiKey()
    const webhook = await this.repository.find(destination.id)
    if (!webhook) throw new Error('webhook record vanished during registration')
    const secret = await this.box.open(webhook.secretSealed, secretOf(destination.id))
    const notificationId = await this.notifications.upsertCustom(destination.baseUrl, key, {
      name: `botyard-${destination.id}`,
      endpoint,
      headers: { [WEBHOOK_TOKEN_HEADER]: secret },
    })
    if (!(await this.repository.recordRegistered(destination.id, destination.baseUrl, notificationId, endpoint))) {
      this.logger.warn({ destinationId: destination.id }, 'destination moved during webhook registration, result discarded')
    }
  }

  /** Секрет из заголовка совпадает с секретом назначения. Неизвестное назначение — тоже `false` */
  async verify(destinationId: string, token: string | undefined): Promise<boolean> {
    if (!token) return false
    const webhook = await this.repository.find(destinationId)
    if (!webhook) return false
    const expected = Buffer.from(await this.box.open(webhook.secretSealed, secretOf(destinationId)))
    const actual = Buffer.from(token)

    return expected.length === actual.length && timingSafeEqual(expected, actual)
  }
}
