import { Controller, Get, Inject, Req, Res } from '@nestjs/common'
import type { Request, Response } from 'express'
import { DEPLOYMENT_EVENTS, type DeploymentEvents } from '../../../shared/realtime/deployment-events'
import type { Operator } from '../../auth/domain/auth'
import { CurrentOperator } from '../../auth/presentation/session.guard'
import { SessionStreams } from '../../auth/presentation/session-streams'

/**
 * Живой статус для админки: поток `deployment` с `{ deploymentId }` — сигнал перечитать развёртывание через API.
 * Само состояние в поток не кладётся: события приходят из разных процессов, а правда — в базе. `resync` —
 * события могли потеряться (разрыв шины): перечитать всё.
 */
@Controller('events')
export class DeploymentEventsController {
  constructor(
    @Inject(DEPLOYMENT_EVENTS) private readonly events: DeploymentEvents,
    private readonly streams: SessionStreams,
  ) {}

  @Get('deployments')
  deployments(@CurrentOperator() operator: Operator, @Req() request: Request, @Res() response: Response): void {
    const stream = this.streams.start(request, response, operator, 'events')
    const unsubscribe = this.events.subscribe(
      (deploymentId) => stream.send('deployment', { deploymentId }),
      // События за разрыв шины потеряны: клиент перечитывает весь список
      () => stream.send('resync', {}),
    )
    stream.onClose(unsubscribe)
  }
}
