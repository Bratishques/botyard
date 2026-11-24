import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  UnsupportedMediaTypeException,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { Request } from 'express'
import { AuthService, type Operator } from '../application/auth.service'

export const SESSION_COOKIE = 'botyard_session'

const PUBLIC = Symbol('PUBLIC')
/** Ручка без входа: health, вход */
export const Public = () => SetMetadata(PUBLIC, true)

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
 * CSRF: cookie с SameSite=Strict плюс требование JSON у изменяющих запросов. HTML-форма с чужого
 * сайта не может отправить `application/json` без CORS-предзапроса, а CORS api не открывает.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthedRequest>()
    if (UNSAFE.has(request.method) && !request.headers['content-type']?.startsWith('application/json')) {
      throw new UnsupportedMediaTypeException({ code: 'JSON_REQUIRED', message: 'request must be application/json' })
    }

    if (this.reflector.getAllAndOverride<boolean>(PUBLIC, [context.getHandler(), context.getClass()])) return true

    const token = readCookie(request.headers.cookie, SESSION_COOKIE)
    const operator = token ? await this.auth.resolve(token) : null
    if (!operator) throw new UnauthorizedException({ code: 'UNAUTHENTICATED', message: 'sign in required' })

    request.operator = operator
    return true
  }
}

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const [key, ...value] = part.trim().split('=')
    if (key === name) return decodeURIComponent(value.join('='))
  }

  return null
}
