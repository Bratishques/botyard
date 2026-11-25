import { Injectable } from '@nestjs/common'
import { z } from 'zod'
import { DokployClient } from '../../../shared/dokploy/dokploy.client'
import type { DokployNotifications } from '../domain/webhook'

/**
 * Уведомления — только имена и id: в ответе `notification.all` лежат заголовки уведомлений открытым текстом
 * (вместе с нашим секретом) и настройки чужих уведомлений; схема отбрасывает всё остальное
 */
const notificationsSchema = z.array(
  z.object({
    notificationId: z.string().min(1),
    name: z.string(),
    notificationType: z.string(),
    customId: z.string().nullable().optional(),
  }),
)

/** События, на которые подписывается Botyard: успех и ошибка сборки; прочие уведомления организации — нет */
const EVENTS = {
  appDeploy: true,
  appBuildError: true,
  databaseBackup: false,
  dokployBackup: false,
  volumeBackup: false,
  dokployRestart: false,
  dockerCleanup: false,
  serverThreshold: false,
} as const

/**
 * Custom-уведомление в Dokploy (проверено на v0.31.4): `notification.createCustom` и `updateCustom` отвечают
 * пустым телом, поэтому id находится по уникальному имени в `notification.all`. Повторный вызов перезаписывает
 * адрес и заголовки — регистрация повторяема.
 */
@Injectable()
export class DokployNotificationsAdapter implements DokployNotifications {
  constructor(private readonly client: DokployClient) {}

  async upsertCustom(
    baseUrl: string,
    apiKey: string,
    notification: { name: string; endpoint: string; headers: Record<string, string> },
  ): Promise<string> {
    const target = { baseUrl, apiKey }
    // Две одновременные регистрации могли создать два уведомления с одним именем: лишнее слало бы каждое событие
    // дважды и не обновлялось бы при смене адреса — оставить одно. Какое — не по порядку ответа Dokploy (он не
    // гарантирован), а наименьший id: так любые две чистки оставят одно и то же
    const [existing, ...duplicates] = (await this.findAll(target, notification.name)).sort((a, b) =>
      a.notificationId < b.notificationId ? -1 : a.notificationId > b.notificationId ? 1 : 0,
    )
    for (const duplicate of duplicates) {
      await this.client.command(target, 'notification.remove', { notificationId: duplicate.notificationId })
    }
    if (existing?.customId) {
      await this.client.command(target, 'notification.updateCustom', {
        notificationId: existing.notificationId,
        customId: existing.customId,
        ...notification,
        ...EVENTS,
      })
      return existing.notificationId
    }

    await this.client.command(target, 'notification.createCustom', { ...notification, ...EVENTS })
    const [created] = await this.findAll(target, notification.name)
    if (!created) throw new Error(`dokploy notification ${notification.name} was not found after creation`)

    return created.notificationId
  }

  private async findAll(target: { baseUrl: string; apiKey: string }, name: string) {
    const all = await this.client.query(target, 'notification.all', {}, notificationsSchema)

    return all.filter((item) => item.notificationType === 'custom' && item.name === name)
  }
}
