import { createHash } from 'node:crypto'
import { Inject, Injectable } from '@nestjs/common'
import { Counter } from 'prom-client'
import { UnitOfWork } from '../../../shared/database/unit-of-work'
import { WebhookInbox } from '../../../shared/inbox/inbox'
import { registry } from '../../../shared/observability/metrics'
import { Outbox, OutboxTopic } from '../../../shared/outbox/outbox'
import { OPERATION_STORE, type OperationStore } from '../domain/operation-store'

const received = new Counter({
  name: 'botyard_dokploy_webhooks_total',
  help: 'Вебхуки Dokploy о сборке по исходу обработки',
  labelNames: ['result'],
  registers: [registry],
})

/** Событие сборки из custom-уведомления Dokploy (test/fixtures/dokploy/webhook.build-*.json) */
export interface BuildEvent {
  readonly type: string
  readonly status: string
  readonly applicationName: string
  readonly timestamp: string
}

export type WebhookResult = 'nudged' | 'duplicate' | 'ignored'

/**
 * Вебхук Dokploy о сборке — подсказка, а не источник правды: он только будит ожидание деплоя (`await_deploy`)
 * сразу, не дожидаясь очередного опроса. Итог воркер берёт из `deployment.all`, поэтому подделка или чужое
 * событие дают лишний опрос, но не меняют статус.
 *
 * Принятие события, пробуждение и команда в outbox — одна транзакция: дубль события отсекает inbox.
 */
@Injectable()
export class DokployWebhookHandler {
  constructor(
    @Inject(OPERATION_STORE) private readonly store: OperationStore,
    private readonly inbox: WebhookInbox,
    private readonly outbox: Outbox,
    private readonly unitOfWork: UnitOfWork,
  ) {}

  async handle(destinationId: string, event: BuildEvent): Promise<WebhookResult> {
    const result = await this.unitOfWork.run(async (): Promise<WebhookResult> => {
      const dedupKey = createHash('sha256')
        .update([destinationId, event.applicationName, event.status, event.timestamp].join('\n'))
        .digest('hex')
      const accepted = await this.inbox.accept({ dedupKey, destinationId, applicationName: event.applicationName, status: event.status })
      if (!accepted) return 'duplicate'
      if (event.type !== 'build') return 'ignored'

      const wake = Bun.randomUUIDv7()
      const awaiting = await this.store.nudgeAwaitingDeploy(destinationId, event.applicationName, wake)
      if (!awaiting) return 'ignored'
      await this.outbox.enqueue(OutboxTopic.OPERATION_STEP, {
        operationId: awaiting.operationId,
        deploymentId: awaiting.deploymentId,
        kind: awaiting.kind,
        step: awaiting.step,
        wake,
      })

      return 'nudged'
    })
    received.inc({ result })

    return result
  }
}
