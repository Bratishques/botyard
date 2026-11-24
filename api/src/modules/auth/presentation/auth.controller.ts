import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res, UnauthorizedException } from '@nestjs/common'
import type { Request, Response } from 'express'
import { z } from 'zod'
import { APP_CONFIG, type AppConfig } from '../../../shared/config/config'
import { ZodBody } from '../../../shared/http/zod-body'
import { AuthService, InvalidCredentialsError, type Operator } from '../application/auth.service'
import { CurrentOperator, Public, readCookie, SESSION_COOKIE } from './session.guard'

const loginSchema = z.object({ email: z.string().min(3).max(254), password: z.string().min(1).max(256) })

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
    @Body(new ZodBody(loginSchema)) body: z.infer<typeof loginSchema>,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Operator> {
    try {
      const { token, operator, expiresAt } = await this.auth.login(body.email, body.password)
      response.cookie(SESSION_COOKIE, token, {
        httpOnly: true,
        secure: this.config.SESSION_COOKIE_SECURE,
        sameSite: 'strict',
        path: '/',
        expires: expiresAt,
      })

      return operator
    } catch (error) {
      if (error instanceof InvalidCredentialsError) throw new UnauthorizedException({ code: 'INVALID_CREDENTIALS', message: error.message })
      throw error
    }
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Req() request: Request, @Res({ passthrough: true }) response: Response): Promise<void> {
    const token = readCookie(request.headers.cookie, SESSION_COOKIE)
    if (token) await this.auth.logout(token)
    response.clearCookie(SESSION_COOKIE, { path: '/' })
  }

  @Get('me')
  me(@CurrentOperator() operator: Operator): Operator {
    return operator
  }
}
