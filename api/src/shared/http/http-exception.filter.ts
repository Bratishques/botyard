import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, HttpStatus, Logger, NotFoundException } from '@nestjs/common'
import type { Response } from 'express'

/** Тело ошибки по контракту админ-API: админка показывает текст по `code`, `message` — для логов */
export interface ErrorBody {
  code: string
  message: string
}

/**
 * Единый формат ошибок `{ code, message }` (docs/api-contract.md).
 *
 * - Ответ, который уже несёт свой `code` или собственную форму (`/health/ready` с `failed`), отдаётся как есть.
 * - Стандартный ответ Nest `{ statusCode, message, error }` приводится к `{ code, message }`.
 * - 404 маршрута не повторяет путь: в нём бывает query с токеном, а ответ уходит клиенту.
 * - Неизвестная ошибка — `500 INTERNAL` без подробностей наружу; подробности — в лог.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name)

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>()
    const { status, body } = this.describe(exception)

    response.status(status).json(body)
  }

  private describe(exception: unknown): { status: number; body: unknown } {
    if (!(exception instanceof HttpException)) {
      this.logger.error({ err: exception }, 'unhandled error')
      return { status: HttpStatus.INTERNAL_SERVER_ERROR, body: { code: 'INTERNAL', message: 'internal error' } satisfies ErrorBody }
    }

    const status = exception.getStatus()
    // Ошибка разбора JSON-тела: текст парсера повторяет кусок тела, а в теле бывают секреты
    if (status === HttpStatus.BAD_REQUEST && isBodyParseError(exception)) {
      return { status, body: { code: 'INVALID_JSON', message: 'request body is not valid JSON' } satisfies ErrorBody }
    }
    if (exception instanceof NotFoundException && isNestRouteNotFound(exception)) {
      return { status, body: { code: 'NOT_FOUND', message: 'route not found' } satisfies ErrorBody }
    }

    const payload = exception.getResponse()
    if (typeof payload === 'object' && payload !== null && !isNestDefault(payload)) return { status, body: payload }

    const message = typeof payload === 'string' ? payload : String((payload as { message?: unknown }).message ?? exception.message)
    return { status, body: { code: codeFor(status), message } satisfies ErrorBody }
  }
}

/** Стандартная форма Nest: `{ statusCode, message, error? }` без своего `code` */
function isNestDefault(payload: object): boolean {
  return 'statusCode' in payload && 'message' in payload && !('code' in payload)
}

/** Ошибка body-parser: исходная ошибка с `type: 'entity.parse.failed'` или `SyntaxError` в причине */
function isBodyParseError(exception: HttpException): boolean {
  const cause: unknown = exception.cause
  if (cause instanceof SyntaxError) return true

  return typeof cause === 'object' && cause !== null && 'type' in cause && cause.type === 'entity.parse.failed'
}

/** 404 роутера Nest: `Cannot GET /path?query` — путь из запроса, наружу не отдаётся */
function isNestRouteNotFound(exception: NotFoundException): boolean {
  return /^Cannot [A-Z]+ /.test(exception.message)
}

function codeFor(status: number): string {
  const name = HttpStatus[status]

  return typeof name === 'string' ? name : 'ERROR'
}
