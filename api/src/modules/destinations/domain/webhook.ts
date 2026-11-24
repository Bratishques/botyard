/**
 * Вебхук Dokploy на назначении: custom-уведомление организации Dokploy о сборках (успех и ошибка), которое
 * Dokploy шлёт POST-ом на api. Подписи у Dokploy нет — только заданные нами заголовки, поэтому в заголовке
 * секрет назначения. Вебхук — подсказка, а не источник правды: он будит ожидание деплоя, итог воркер берёт
 * из `deployment.all`. Подделка с утёкшим секретом даст лишний опрос, но не сменит статус.
 */
export const WEBHOOK_TOKEN_HEADER = 'x-botyard-token'

export interface DestinationWebhook {
  readonly destinationId: string
  readonly secretSealed: Uint8Array
  readonly notificationId: string | null
  readonly endpoint: string | null
  readonly error: string | null
  readonly registeredAt: Date | null
}

export interface DestinationWebhookRepository {
  find(destinationId: string): Promise<DestinationWebhook | null>
  /** Создать запись с секретом, если её нет; вернуть действующую (гонка двух регистраций — одна запись) */
  ensure(destinationId: string, secretSealed: Uint8Array): Promise<DestinationWebhook>
  /**
   * Записать регистрацию, только если назначение всё ещё указывает на тот Dokploy, где регистрировали: проверка,
   * начатая до переезда назначения, не должна выдать уведомление старого Dokploy за действующее. `false` — устарела
   */
  recordRegistered(destinationId: string, baseUrl: string, notificationId: string, endpoint: string): Promise<boolean>
  recordFailed(destinationId: string, error: string): Promise<void>
}

export const DESTINATION_WEBHOOK_REPOSITORY = Symbol('DESTINATION_WEBHOOK_REPOSITORY')

/** Уведомления Dokploy: найти своё по имени и создать или перезаписать — повторяемо */
export interface DokployNotifications {
  upsertCustom(
    baseUrl: string,
    apiKey: string,
    notification: { name: string; endpoint: string; headers: Record<string, string> },
  ): Promise<string>
}

export const DOKPLOY_NOTIFICATIONS = Symbol('DOKPLOY_NOTIFICATIONS')
