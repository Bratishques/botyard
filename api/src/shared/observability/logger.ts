import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Params } from 'nestjs-pino'
import type { AppConfig } from '../config/config'
import { pathOnly, redactDeep } from './redact'

interface RequestLike {
  id?: unknown
  method?: string
  url?: string
  headers?: Record<string, unknown>
}

/**
 * Секреты маскируются по имени поля на любой глубине (`redactDeep`), а не списком путей:
 * в лог попадают ошибки адаптеров и заголовки произвольной вложенности. Тело запроса pino-http
 * не пишет вообще, query отрезается от url. Маскирование — страховка: правило «не логировать
 * объект с секретом целиком» оно не отменяет.
 */
export function loggerOptions(config: AppConfig): Params {
  return {
    pinoHttp: {
      level: config.LOG_LEVEL,
      serializers: {
        req: (request: RequestLike) =>
          redactDeep({ id: request.id, method: request.method, url: pathOnly(request.url), headers: request.headers }),
        res: (response: { statusCode?: number }) => ({ statusCode: response.statusCode }),
      },
      formatters: { log: (object: Record<string, unknown>) => redactDeep(object) as Record<string, unknown> },
      // Пробы дёргаются каждые несколько секунд и забивают лог, но отказ пробы обязан быть виден
      customLogLevel: (request: IncomingMessage, response: ServerResponse, error?: Error) => {
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
