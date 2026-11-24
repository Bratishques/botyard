import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Params } from 'nestjs-pino'
import pino, { type Logger as PinoLogger } from 'pino'
import type { AppConfig } from '../config/config'
import { isSecretKey, pathOnly, REDACTED, redactDeep, redactString } from './redact'

interface RequestLike {
  id?: unknown
  method?: string
  url?: string
  headers?: Record<string, unknown>
  remoteAddress?: string
}

/** Поля записи pino-http, которыми занимаются сериализаторы: форматтер их не трогает */
const SERIALIZED_KEYS = new Set(['req', 'res', 'err'])

/**
 * Секреты маскируются по имени поля и виду значения на любой глубине (`redactDeep`). Порядок
 * в pino: сначала `formatters.log`, потом сериализаторы. Поэтому форматтер пропускает `req`,
 * `res` и `err` — в них живые объекты HTTP и ошибки, — а маскируют их сами сериализаторы.
 * Тело запроса pino-http не пишет, query отрезается от url.
 */
export function loggerOptions(config: AppConfig): Params {
  return {
    pinoHttp: {
      level: config.LOG_LEVEL,
      serializers: {
        req: (request: RequestLike) =>
          redactDeep({
            id: request.id,
            method: request.method,
            url: pathOnly(request.url),
            headers: request.headers,
            remoteAddress: request.remoteAddress,
          }),
        res: (response: { statusCode?: number }) => ({ statusCode: response.statusCode }),
        err: serializeError,
        // Текст сообщения тоже маскируется: Nest пишет в msg сообщение ошибки как есть
        msg: (message: unknown) => (typeof message === 'string' ? redactString(message) : message),
      },
      formatters: { log: redactLogObject },
      // Пробы дёргаются каждые несколько секунд и забивают лог, но отказ пробы обязан быть виден
      customLogLevel: (request: IncomingMessage, response: ServerResponse, error?: Error) => {
        // Отказ пробы — уже warn от самой проверки; второй error со стеком на каждую пробу — шум
        if (isProbe(request.url) && response.statusCode === 503) return 'warn'
        if (error || response.statusCode >= 500) return 'error'
        if (response.statusCode >= 400) return 'warn'

        return isProbe(request.url) ? 'silent' : 'info'
      },
      // Отказ пробы описывает warn самой проверки, стек синтетической ошибки 503 каждые несколько секунд не нужен
      customErrorObject: (request: IncomingMessage, _response: ServerResponse, _error: Error, value: Record<string, unknown>) =>
        isProbe(request.url) ? { ...value, err: undefined } : value,
      transport: config.LOG_PRETTY ? { target: 'pino-pretty', options: { singleLine: true } } : undefined,
    },
  }
}

function redactLogObject(object: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(object)) {
    if (SERIALIZED_KEYS.has(key)) result[key] = value
    else result[key] = isSecretKey(key) && value !== undefined && value !== null ? REDACTED : redactDeep(value)
  }

  return result
}

/** Логгер фоновых процессов (relay, воркер): тот же JSON pino и та же маскировка, что у http */
export function createProcessLogger(config: Pick<AppConfig, 'LOG_LEVEL' | 'LOG_PRETTY'>, name: string): PinoLogger {
  return pino({
    name,
    level: config.LOG_LEVEL,
    serializers: { err: serializeError },
    formatters: { log: redactLogObject },
    hooks: {
      logMethod(args, method) {
        method.apply(this, args.map((arg) => (typeof arg === 'string' ? redactString(arg) : arg)) as Parameters<typeof method>)
      },
    },
    transport: config.LOG_PRETTY ? { target: 'pino-pretty', options: { singleLine: true } } : undefined,
  })
}

/**
 * pino-http передаёт сюда уже сериализованную ошибку (исходная — в неперечисляемом `raw`), pino — сырую.
 * Маска обходит исходную ошибку: так сохраняются тип, `cause`, вложенные ошибки и свои поля.
 */
function serializeError(error: unknown): unknown {
  const raw = error instanceof Error ? error : (error as { raw?: unknown } | null)?.raw
  if (raw instanceof Error) return redactDeep(raw)
  if (typeof error === 'string') return redactString(error)

  return redactDeep(error)
}

function isProbe(url: string | undefined): boolean {
  return url?.toLowerCase().startsWith('/health/') ?? false
}
