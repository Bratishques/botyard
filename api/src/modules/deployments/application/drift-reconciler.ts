import { Inject, Injectable, Logger } from '@nestjs/common'
import { Counter } from 'prom-client'
import { AuditLog } from '../../../shared/audit/audit'
import { UnitOfWork } from '../../../shared/database/unit-of-work'
import { registry } from '../../../shared/observability/metrics'
import { DestinationUseCases } from '../../destinations/application/destination-use-cases'
import { DEPLOYMENT_REPOSITORY, type Deployment, type DeploymentRepository, driftOf } from '../domain/deployment'
import { DEPLOYMENT_PLATFORM, type DeploymentPlatform } from '../domain/deployment-platform'

const detected = new Counter({
  name: 'botyard_reconciler_drift_changes_total',
  help: 'Изменения дрейфа развёртываний относительно Dokploy',
  labelNames: ['drift'],
  registers: [registry],
})

export const DRIFT = {
  /** Сверять каждое развёртывание не чаще: каждая сверка — запрос в Dokploy назначения */
  intervalMs: 5 * 60_000,
  batch: 20,
} as const

const ACTOR = 'system:reconciler'

/**
 * Сверка развёртываний без активной операции с Dokploy: робота остановили, запустили или удалили руками, его
 * передеплой упал. Найденное — наблюдение (`drift`), а не новый статус: молча «чинить» нельзя — оператор мог
 * остановить робота в Dokploy намеренно. Изменение дрейфа пишется в аудит.
 *
 * - Запись условна: версия та же и операции нет. Начатая оператором операция важнее наблюдения, а завершение
 *   операции сбрасывает дрейф (операция сама привела Dokploy к своему итогу).
 * - Ошибка Dokploy — пропуск до следующего раза; время сверки всё равно записывается, чтобы лежащее назначение
 *   не опрашивалось каждый проход.
 * - Что контейнер робота падает в цикле, по API Dokploy не видно: это дрейфом не считается.
 */
@Injectable()
export class DriftReconciler {
  private readonly logger = new Logger(DriftReconciler.name)

  constructor(
    @Inject(DEPLOYMENT_REPOSITORY) private readonly deployments: DeploymentRepository,
    @Inject(DEPLOYMENT_PLATFORM) private readonly platform: DeploymentPlatform,
    private readonly destinations: DestinationUseCases,
    private readonly unitOfWork: UnitOfWork,
    private readonly audit: AuditLog,
  ) {}

  async tick(): Promise<{ checked: number; changed: number }> {
    const result = { checked: 0, changed: 0 }
    for (const deployment of await this.deployments.dueForDriftCheck(DRIFT.intervalMs, DRIFT.batch)) {
      result.checked++
      if (await this.check(deployment)) result.changed++
    }

    return result
  }

  private async check(deployment: Deployment): Promise<boolean> {
    let drift: ReturnType<typeof driftOf>
    try {
      if (!deployment.dokployAppId) return false
      const { destination, apiKey } = await this.destinations.connection(deployment.destinationId)
      const target = { baseUrl: destination.baseUrl, apiKey, environmentId: destination.environmentId, serverId: destination.serverId }
      drift = driftOf(deployment.status, await this.platform.appStatus(target, deployment.dokployAppId))
    } catch (error) {
      this.logger.warn({ deploymentId: deployment.id, reason: error instanceof Error ? error.message : 'failed' }, 'drift check failed')
      drift = undefined
    }

    return this.unitOfWork.run(async () => {
      const recorded = await this.deployments.recordDrift(deployment.id, deployment.version, drift)
      if (!recorded || drift === undefined || recorded.previous === drift) return false

      await this.audit.record({
        actor: ACTOR,
        action: drift === null ? 'deployment.drift_cleared' : 'deployment.drift_detected',
        targetType: 'deployment',
        targetId: deployment.id,
        payload: { drift, previous: recorded.previous, status: deployment.status },
      })
      detected.inc({ drift: drift ?? 'none' })

      return true
    })
  }
}
