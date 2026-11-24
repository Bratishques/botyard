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

  async register(destination: Pick<Destination, 'id' | 'baseUrl'>, apiKey: string): Promise<void> {
    const endpoint = this.endpointOf(destination.id)
    if (!endpoint) return

    // Целиком «лучшее усилие»: сбой базы или шифрования здесь не должен ронять создание или проверку назначения
    try {
      const fresh = randomBytes(32).toString('base64url')
      const webhook = await this.repository.ensure(destination.id, await this.box.seal(fresh, secretOf(destination.id)))
      const secret = await this.box.open(webhook.secretSealed, secretOf(destination.id))
      const notificationId = await this.notifications.upsertCustom(destination.baseUrl, apiKey, {
        name: `botyard-${destination.id}`,
        endpoint,
        headers: { [WEBHOOK_TOKEN_HEADER]: secret },
      })
      if (!(await this.repository.recordRegistered(destination.id, destination.baseUrl, notificationId, endpoint))) {
        this.logger.warn({ destinationId: destination.id }, 'destination moved during webhook registration, result discarded')
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'registration failed'
      this.logger.warn({ destinationId: destination.id, reason }, 'dokploy webhook registration failed, polling stays in charge')
      await this.repository.recordFailed(destination.id, reason).catch(() => undefined)
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
