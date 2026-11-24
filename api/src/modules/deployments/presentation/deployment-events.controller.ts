import { Controller, Get, Inject, Req, Res } from '@nestjs/common'
import type { Request, Response } from 'express'
import { openSse } from '../../../shared/http/sse'
import { DEPLOYMENT_EVENTS, type DeploymentEvents } from '../../../shared/realtime/deployment-events'

/**
 * Живой статус для админки: поток `deployment` с `{ deploymentId }` — сигнал перечитать развёртывание через API.
 * Само состояние в поток не кладётся: события приходят из разных процессов, а правда — в базе.
 */
@Controller('events')
export class DeploymentEventsController {
  constructor(@Inject(DEPLOYMENT_EVENTS) private readonly events: DeploymentEvents) {}

  @Get('deployments')
  deployments(@Req() request: Request, @Res() response: Response): void {
    const stream = openSse(request, response)
    const unsubscribe = this.events.subscribe((deploymentId) => stream.send('deployment', { deploymentId }))
    stream.onClose(unsubscribe)
  }
}
