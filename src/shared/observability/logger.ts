import type { Params } from 'nestjs-pino'
import type { AppConfig } from '../config/config'

/**
 * Пути, которые pino заменяет маской до записи. Секреты сюда попадают из тел запросов
 * (токен клиента, ключ назначения) и из заголовков. Маскирование — страховка: правило
 * «не логировать объект с секретом целиком» оно не отменяет.
 */
export const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["idempotency-key"]',
  'res.headers["set-cookie"]',
  '*.apiKey',
  '*.token',
  '*.tinvestToken',
  '*.password',
]

export function loggerOptions(config: AppConfig): Params {
  return {
    pinoHttp: {
      level: config.LOG_LEVEL,
      redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
      // Пробы и метрики дёргаются каждые несколько секунд и забивают лог
      autoLogging: { ignore: (request) => request.url?.startsWith('/health') ?? false },
      transport: config.NODE_ENV === 'development' ? { target: 'pino-pretty', options: { singleLine: true } } : undefined,
    },
  }
}
