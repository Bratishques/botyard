/**
 * Исходы вызова Dokploy, которые различает вызывающий:
 *
 * - `DokployUnauthorizedError` — ключ не принят (401/403): назначение настроено неверно, повтор не поможет;
 * - `DokployRejectedError` — запрос отклонён (прочие 4xx): ошибка в данных, повтор не поможет;
 * - `DokployUnavailableError` — сеть, таймаут, 5xx, 429 после всех попыток, разомкнутая цепь: исход
 *   неизвестен или временный. Для изменяющих вызовов это не «не сделано», а «не знаем».
 * - `DokployResponseError` — ответ не совпал со схемой: Dokploy изменил API или прислал не то.
 */
export class DokployError extends Error {}

export class DokployUnauthorizedError extends DokployError {
  override readonly name = 'DokployUnauthorizedError'
}

export class DokployRejectedError extends DokployError {
  override readonly name = 'DokployRejectedError'

  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export class DokployUnavailableError extends DokployError {
  override readonly name = 'DokployUnavailableError'

  constructor(
    message: string,
    readonly retryAfterMs?: number,
    options?: { cause?: unknown },
  ) {
    super(message, options)
  }
}

export class DokployResponseError extends DokployError {
  override readonly name = 'DokployResponseError'
}
