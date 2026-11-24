import { type LoginBody, loginSchema } from '@botyard/contract'
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Post,
  Req,
  Res,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common'
import type { Request, Response } from 'express'
import { APP_CONFIG, type AppConfig } from '../../../shared/config/config'
import { Public } from '../../../shared/http/public'
import { ZodBody } from '../../../shared/http/zod-body'
import { AuthService } from '../application/auth.service'
import { AuthError, AuthErrorCode, type Operator } from '../domain/auth'
import { CurrentOperator, readCookie, SESSION_COOKIE } from './session.guard'

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(
    @Body(new ZodBody(loginSchema)) body: LoginBody,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Operator> {
    try {
      const { token, operator, expiresAt } = await this.auth.login(body.email, body.password, request.ip ?? 'unknown')
      response.cookie(SESSION_COOKIE, token, {
        httpOnly: true,
        secure: this.config.SESSION_COOKIE_SECURE,
        sameSite: 'strict',
        path: '/',
        expires: expiresAt,
      })

      return operator
    } catch (error) {
      if (!(error instanceof AuthError)) throw error
      if (error.retryAfterMs !== undefined) response.setHeader('Retry-After', String(Math.ceil(error.retryAfterMs / 1_000)))
      if (error.code === AuthErrorCode.LOGIN_THROTTLED) {
        throw new HttpException({ code: error.code, message: error.message }, HttpStatus.TOO_MANY_REQUESTS)
      }
      if (error.code === AuthErrorCode.LOGIN_BUSY) throw new ServiceUnavailableException({ code: error.code, message: error.message })
      throw new UnauthorizedException({ code: AuthErrorCode.INVALID_CREDENTIALS, message: 'invalid email or password' })
    }
  }

  /** Публичная: выйти можно и с истёкшей сессией — cookie очищается в любом случае */
  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() request: Request, @Res({ passthrough: true }) response: Response): Promise<void> {
    const token = readCookie(request.headers.cookie, SESSION_COOKIE)
    if (token) await this.auth.logout(token)
    response.clearCookie(SESSION_COOKIE, { path: '/', httpOnly: true, sameSite: 'strict', secure: this.config.SESSION_COOKIE_SECURE })
  }

  @Get('me')
  me(@CurrentOperator() operator: Operator): Operator {
    return operator
  }
}
