import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
  UnsupportedMediaTypeException,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { Request } from 'express'
import { PUBLIC_ROUTE } from '../../../shared/http/public'
import { AuthService } from '../application/auth.service'
import type { Operator } from '../domain/auth'

export const SESSION_COOKIE = 'botyard_session'

type AuthedRequest = Request & { operator?: Operator }

/** Текущий оператор; в аудит идёт как `operator:<id>` */
export const CurrentOperator = createParamDecorator((_data: unknown, context: ExecutionContext): Operator => {
  const operator = context.switchToHttp().getRequest<AuthedRequest>().operator
  if (!operator) throw new UnauthorizedException({ code: 'UNAUTHENTICATED', message: 'sign in required' })

  return operator
})

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/**
 * Глобальный guard: всё закрыто, кроме помеченного `@Public()`.
 *
 * CSRF: cookie с SameSite=Strict плюс требование JSON у изменяющих запросов — в том числе публичных
 * (вход): HTML-форма с чужого сайта не может отправить `application/json` без CORS-предзапроса, а CORS
 * api не открывает.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthedRequest>()
    // Медиатип регистронезависим (RFC 9110, 8.3.1)
    const contentType = request.headers['content-type']?.toLowerCase() ?? ''
    if (UNSAFE.has(request.method) && !contentType.startsWith('application/json')) {
      throw new UnsupportedMediaTypeException({ code: 'JSON_REQUIRED', message: 'request must be application/json' })
    }

    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, [context.getHandler(), context.getClass()])) return true

    const token = readCookie(request.headers.cookie, SESSION_COOKIE)
    const operator = token ? await this.auth.resolve(token) : null
    if (!operator) throw new UnauthorizedException({ code: 'UNAUTHENTICATED', message: 'sign in required' })

    request.operator = operator
    return true
  }
}

/** Значение cookie; битая кодировка — как отсутствие cookie (401), а не 500 */
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const [key, ...value] = part.trim().split('=')
    if (key !== name) continue
    try {
      return decodeURIComponent(value.join('='))
    } catch {
      return null
    }
  }

  return null
}
