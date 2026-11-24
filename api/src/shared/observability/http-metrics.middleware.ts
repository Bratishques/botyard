import { Injectable, type NestMiddleware } from '@nestjs/common'
import type { NextFunction, Request, Response } from 'express'
import { httpRequestDuration } from './metrics'

/**
 * Метка `route` — шаблон маршрута (`/destinations/:id`), а не фактический путь: иначе каждый id
 * стал бы отдельной серией, и кардинальность метрики росла бы без предела.
 *
 * Запрос, не совпавший ни с одним контроллером, Nest отдаёт маршруту-ловушке `/{*splat}`
 * (а без неё — вовсе без `request.route`). Оба случая — одна серия `unmatched`. Шаблонов
 * со звёздочкой в своих контроллерах api не использует, поэтому `*` однозначно значит ловушку.
 */
@Injectable()
export class HttpMetricsMiddleware implements NestMiddleware {
  use(request: Request, response: Response, next: NextFunction): void {
    const stop = httpRequestDuration.startTimer()

    response.on('finish', () => {
      const route: unknown = request.route?.path
      const matched = typeof route === 'string' && !route.includes('*')
      stop({
        method: request.method,
        route: matched ? `${request.baseUrl}${route}` : 'unmatched',
        status: String(response.statusCode),
      })
    })

    next()
  }
}
