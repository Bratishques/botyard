import { Injectable, type NestMiddleware } from '@nestjs/common'
import type { NextFunction, Request, Response } from 'express'
import { httpRequestDuration, httpRequestsTotal } from './metrics'

/**
 * Метка `route` — шаблон маршрута (`/destinations/:id`), а не фактический путь: иначе каждый id
 * стал бы отдельной серией, и кардинальность метрики росла бы без предела.
 */
@Injectable()
export class HttpMetricsMiddleware implements NestMiddleware {
  use(request: Request, response: Response, next: NextFunction): void {
    const stop = httpRequestDuration.startTimer()

    response.on('finish', () => {
      // Несовпавший запрос попадает в маршрут-ловушку `/{*splat}`: это одна серия «unmatched», а не путь
      const route: unknown = request.route?.path
      const matched = typeof route === 'string' && !route.includes('*')
      const labels = {
        method: request.method,
        route: matched ? `${request.baseUrl}${route}` : 'unmatched',
        status: String(response.statusCode),
      }
      stop(labels)
      httpRequestsTotal.inc(labels)
    })

    next()
  }
}
