import { Body, Controller, Headers, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, UnauthorizedException } from '@nestjs/common'
import { z } from 'zod'
import { Public } from '../../../shared/http/public'
import { ZodBody } from '../../../shared/http/zod-body'
import { DestinationWebhooks } from '../../destinations/application/destination-webhooks'
import { WEBHOOK_TOKEN_HEADER } from '../../destinations/domain/webhook'
import { DokployWebhookHandler } from '../application/dokploy-webhook-handler'

/** Только нужные поля; остальное тело Dokploy (лог сборки в `errorMessage`, домены) не читается и не хранится */
const buildEvent = z.object({
  type: z.string().max(64),
  status: z.string().max(64),
  applicationName: z.string().min(1).max(200),
  timestamp: z.string().max(64),
})

const EVENT_BODY = new ZodBody(buildEvent)

/**
 * Вебхуки Dokploy. Публичная ручка: Dokploy ходит без сессии, подлинность — секрет назначения в заголовке
 * (`x-botyard-token`). Неизвестное назначение и неверный секрет неразличимы — оба 401.
 */
@Public()
@Controller('webhooks/dokploy')
export class DokployWebhookController {
  constructor(
    private readonly webhooks: DestinationWebhooks,
    private readonly handler: DokployWebhookHandler,
  ) {}

  @Post(':destinationId')
  @HttpCode(HttpStatus.OK)
  async receive(
    @Param('destinationId', new ParseUUIDPipe({ exceptionFactory: () => unauthorized() })) destinationId: string,
    @Headers(WEBHOOK_TOKEN_HEADER) token: string | undefined,
    @Body() body: unknown,
  ): Promise<{ result: string }> {
    // Сначала секрет, потом тело: без секрета не узнать даже схему полей
    if (!(await this.webhooks.verify(destinationId, token))) throw unauthorized()

    return { result: await this.handler.handle(destinationId, EVENT_BODY.transform(body)) }
  }
}

function unauthorized(): UnauthorizedException {
  return new UnauthorizedException({ code: 'WEBHOOK_UNAUTHORIZED', message: 'unknown destination or wrong token' })
}
