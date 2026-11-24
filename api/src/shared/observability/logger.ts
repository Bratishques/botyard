import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Params } from 'nestjs-pino'
import { stdSerializers } from 'pino'
import type { AppConfig } from '../config/config'
import { pathOnly, redactDeep } from './redact'

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
        // pino-http передаёт сюда уже сериализованную ошибку, а pino — сырую. Результат стандартного
        // сериализатора — объект со своим прототипом: поля копируются в простой, чтобы маска их обошла
        err: (error: unknown) => redactDeep({ ...(error instanceof Error ? stdSerializers.err(error) : (error as object)) }),
      },
      formatters: {
        log: (object: Record<string, unknown>) => {
          const result: Record<string, unknown> = {}
          for (const [key, value] of Object.entries(object)) result[key] = SERIALIZED_KEYS.has(key) ? value : redactDeep(value)

          return result
        },
      },
      // Пробы дёргаются каждые несколько секунд и забивают лог, но отказ пробы обязан быть виден
      customLogLevel: (request: IncomingMessage, response: ServerResponse, error?: Error) => {
        // Отказ пробы — уже warn от самой проверки; второй error со стеком на каждую пробу — шум
        if (isProbe(request.url) && response.statusCode === 503) return 'warn'
        if (error || response.statusCode >= 500) return 'error'
        if (response.statusCode >= 400) return 'warn'

        return isProbe(request.url) ? 'silent' : 'info'
      },
      transport: config.LOG_PRETTY ? { target: 'pino-pretty', options: { singleLine: true } } : undefined,
    },
  }
}

function isProbe(url: string | undefined): boolean {
  return url?.toLowerCase().startsWith('/health/') ?? false
}
