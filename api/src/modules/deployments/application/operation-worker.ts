import { Inject, Injectable, Logger } from '@nestjs/common'
import { AuditLog } from '../../../shared/audit/audit'
import { UnitOfWork } from '../../../shared/database/unit-of-work'
import { Outbox, OutboxTopic } from '../../../shared/outbox/outbox'
import { TINVEST_ADDRESS } from '../../../shared/tinvest/tinvest'
import { CATALOG_REPOSITORY, type CatalogRepository } from '../../catalog/domain/catalog'
import { CustomerUseCases } from '../../customers/application/customer-use-cases'
import { modeOf } from '../../customers/domain/customer'
import { DestinationUseCases } from '../../destinations/application/destination-use-cases'
import { DEPLOYMENT_REPOSITORY, type Deployment, type DeploymentRepository } from '../domain/deployment'
import { DEPLOYMENT_PLATFORM, type DeploymentPlatform, PlatformError, type PlatformTarget } from '../domain/deployment-platform'
import { type ClaimedStep, OPERATION_STORE, type OperationStore } from '../domain/operation-store'
import { CONFIG_RENDERER, type ConfigRenderer, RenderError } from '../domain/robot-runtime'
import { isSagaStep, NEEDS_ACTIVE_DESTINATION, nextStep, OUTCOME, RETRY, retryDelayMs, SagaStep } from '../domain/saga'

/** Сообщение `operation.step` (пишет outbox, доставляет RabbitMQ) */
export interface StepMessage {
  readonly operationId: string
  readonly deploymentId: string
  readonly kind: string
  readonly step: string
  /** Метка отложенной команды (повтор, опрос); у первой команды шага её нет */
  readonly wake?: string
}

type Context = Record<string, unknown>

/** Итог выполнения шага — решение, которое воркер записывает одной транзакцией с командой в outbox */
type StepOutcome =
  | { readonly type: 'next'; readonly context: Context; readonly dokployAppId?: string | null }
  | { readonly type: 'wait'; readonly context: Context; readonly delayMs: number }
  | { readonly type: 'retry'; readonly delayMs: number; readonly reason: string }
  | { readonly type: 'fail'; readonly error: string; readonly dokployAppId?: string | null }

/** Отказ шага, который повтор не исправит */
class StepFailure extends Error {}

/** Сколько попыток у шага: start в Dokploy ждёт схождения сервиса, и каждая попытка оставляет там процесс */
function maxAttempts(step: SagaStep): number {
  return step === SagaStep.START ? 2 : RETRY.maxAttempts
}

const ACTOR = 'system:worker'
const TERMINAL_FAILURE = new Set(['error', 'cancelled'])

/**
 * Воркер саги: выполняет один шаг операции на сообщение (docs/architecture.md, «Сага»).
 *
 *   аренда шага (условная запись) → вызовы Dokploy вне транзакции → транзакция { переход, следующая команда
 *   в outbox } или { отпустить аренду, повтор с паузой в outbox } или { итог операции и развёртывания }
 *
 * - Повторная доставка шага, пока он арендован, не вызывает Dokploy второй раз: сообщение откладывается
 *   до конца аренды; устаревшее (шаг уже другой, операция завершена) отбрасывается.
 * - Воркер, потерявший аренду, ничего не запишет: все записи — по шагу и номеру попытки.
 * - Перед вызовами Dokploy заново сверяется основание: операция всё ещё активна у развёртывания,
 *   назначение не выключено (для запуска), режим клиента совпадает с режимом развёртывания.
 * - Токен клиента и ключ Dokploy открываются только на время шага и не логируются.
 */
@Injectable()
export class OperationWorker {
  private readonly logger = new Logger(OperationWorker.name)

  constructor(
    @Inject(OPERATION_STORE) private readonly store: OperationStore,
    @Inject(DEPLOYMENT_REPOSITORY) private readonly deployments: DeploymentRepository,
    @Inject(DEPLOYMENT_PLATFORM) private readonly platform: DeploymentPlatform,
    @Inject(CONFIG_RENDERER) private readonly renderer: ConfigRenderer,
    @Inject(CATALOG_REPOSITORY) private readonly catalog: CatalogRepository,
    private readonly customers: CustomerUseCases,
    private readonly destinations: DestinationUseCases,
    private readonly unitOfWork: UnitOfWork,
    private readonly outbox: Outbox,
    private readonly audit: AuditLog,
  ) {}

  async handle(message: StepMessage): Promise<void> {
    if (!isSagaStep(message.step)) {
      this.logger.warn({ operationId: message.operationId, step: message.step }, 'unknown saga step, message dropped')
      return
    }

    const claimed = await this.store.claim(message.operationId, message.step, message.wake ?? null, RETRY.leaseMs)
    if ('reason' in claimed) {
      // Шаг у другого воркера: если тот упадёт, это сообщение подхватит шаг после конца аренды
      if (claimed.reason === 'leased') {
        const delayMs = Math.max(1_000, claimed.until.getTime() - Date.now() + 1_000)
        await this.unitOfWork.run(() => this.outbox.enqueue(OutboxTopic.OPERATION_STEP, { ...message }, { delayMs }))
      }
      return
    }

    let outcome: StepOutcome
    try {
      outcome = await this.execute(claimed)
    } catch (error) {
      outcome = this.outcomeOfError(claimed, error)
    }
    await this.apply(claimed, outcome)
  }

  private async execute(claimed: ClaimedStep): Promise<StepOutcome> {
    const deployment = await this.deployments.findById(claimed.deploymentId)
    if (!deployment || deployment.activeOperationId !== claimed.operationId) {
      throw new StepFailure('the operation is no longer active for this deployment')
    }
    const { destination, apiKey } = await this.destinations.connection(deployment.destinationId)
    if (destination.status === 'DISABLED' && NEEDS_ACTIVE_DESTINATION[claimed.kind]) {
      throw new StepFailure('the destination is disabled')
    }
    const target: PlatformTarget = {
      baseUrl: destination.baseUrl,
      apiKey,
      environmentId: destination.environmentId,
      serverId: destination.serverId,
    }
    const context: Context = { ...claimed.context }

    switch (claimed.step) {
      case SagaStep.ENSURE_APP:
        return this.ensureApp(target, deployment, context)
      case SagaStep.CONFIGURE:
        await this.configure(target, deployment)
        return { type: 'next', context }
      case SagaStep.PREPARE_DEPLOY: {
        const latest = await this.platform.latestDeployment(target, appIdOf(deployment))
        return { type: 'next', context: { ...context, baselineDeploymentId: latest?.id ?? null } }
      }
      case SagaStep.DEPLOY:
        return this.deploy(target, deployment, context)
      case SagaStep.AWAIT_DEPLOY:
        return this.awaitDeploy(target, deployment, context)
      case SagaStep.START:
        await this.platform.start(target, appIdOf(deployment))
        return { type: 'next', context }
      case SagaStep.STOP:
        // Приложение так и не создано (provision упал раньше) — останавливать нечего
        if (deployment.dokployAppId) await this.platform.stop(target, deployment.dokployAppId)
        return { type: 'next', context }
      case SagaStep.DELETE:
        return this.delete(target, deployment, context)
    }
  }

  /**
   * Найти приложение по appName, нет — создать. Поиск первым: ответ на прошлый `create` мог потеряться,
   * и тогда приложение уже есть. Два найденных — кто-то создал руками или сломалась защита; угадывать нельзя.
   */
  private async ensureApp(target: PlatformTarget, deployment: Deployment, context: Context): Promise<StepOutcome> {
    const apps = await this.platform.findApps(target, deployment.appName)
    if (apps.length > 1) {
      throw new StepFailure(`found ${apps.length} Dokploy applications for ${deployment.appName}: remove the extra ones in Dokploy`)
    }
    const app =
      apps[0] ??
      (await this.platform.createApp(target, {
        appName: deployment.appName,
        name: deployment.appName,
        description: `Botyard deployment ${deployment.id}`,
      }))

    return { type: 'next', context, dokployAppId: app.id }
  }

  private async configure(target: PlatformTarget, deployment: Deployment): Promise<void> {
    const customer = await this.customers.get(deployment.customerId)
    if (customer.status !== 'ACTIVE') throw new StepFailure('the customer is archived')
    if (modeOf(customer) !== deployment.tradingMode) {
      throw new StepFailure(`the customer is in ${modeOf(customer)} mode, the deployment was created for ${deployment.tradingMode}`)
    }
    const version = await this.catalog.findVersion(deployment.templateId, deployment.templateVersion)
    if (!version) throw new StepFailure(`template version ${deployment.templateId}@${deployment.templateVersion} is missing`)

    const runtime = this.renderer.render({
      manifest: version.manifest,
      files: version.files,
      config: deployment.config,
      customer: { accountId: customer.accountId, sandbox: customer.sandbox },
      token: await this.customers.revealToken(customer),
      tinvestAddress: TINVEST_ADDRESS[deployment.tradingMode],
    })
    await this.platform.configure(target, appIdOf(deployment), {
      source: { gitUrl: version.manifest.upstream.gitUrl, ref: version.manifest.upstream.ref },
      build: { dockerfile: version.manifest.build.dockerfile, context: version.manifest.build.context },
      runtime,
    })
  }

  /** Запуск деплоя. Новый деплой после запомненного уже есть — прошлая попытка его запустила, второй не нужен */
  private async deploy(target: PlatformTarget, deployment: Deployment, context: Context): Promise<StepOutcome> {
    if (!('baselineDeploymentId' in context)) throw new StepFailure('deploy step without a baseline')
    const appId = appIdOf(deployment)
    const latest = await this.platform.latestDeployment(target, appId)
    if (latest && latest.id !== context.baselineDeploymentId) {
      return { type: 'next', context: { ...context, deployRequestedAt: context.deployRequestedAt ?? new Date().toISOString() } }
    }

    await this.platform.deploy(target, appId)
    return { type: 'next', context: { ...context, deployRequestedAt: new Date().toISOString() } }
  }

  private async awaitDeploy(target: PlatformTarget, deployment: Deployment, context: Context): Promise<StepOutcome> {
    const requestedAt = typeof context.deployRequestedAt === 'string' ? Date.parse(context.deployRequestedAt) : Number.NaN
    if (Number.isNaN(requestedAt)) throw new StepFailure('await step without the deploy time')

    const latest = await this.platform.latestDeployment(target, appIdOf(deployment))
    const ours = latest && latest.id !== context.baselineDeploymentId ? latest : null
    if (ours?.status === 'done') return { type: 'next', context: { ...context, dokployDeploymentId: ours.id } }
    if (ours && TERMINAL_FAILURE.has(ours.status)) {
      throw new StepFailure(`Dokploy deployment ${ours.id} ended with ${ours.status}: see its log in Dokploy`)
    }
    if (Date.now() - requestedAt > RETRY.deployDeadlineMs) {
      throw new StepFailure(`the Dokploy deployment did not finish in ${RETRY.deployDeadlineMs / 60_000} min`)
    }

    // Ещё не виден в списке (очередь Dokploy) или идёт — проверить позже
    return { type: 'wait', context, delayMs: RETRY.pollMs }
  }

  /** Удалить все приложения развёртывания: по сохранённому id и по appName (create мог пройти без ответа) */
  private async delete(target: PlatformTarget, deployment: Deployment, context: Context): Promise<StepOutcome> {
    const ids = new Set((await this.platform.findApps(target, deployment.appName)).map((app) => app.id))
    if (deployment.dokployAppId) ids.add(deployment.dokployAppId)
    for (const id of ids) await this.platform.deleteApp(target, id)

    return { type: 'next', context, dokployAppId: null }
  }

  private outcomeOfError(claimed: ClaimedStep, error: unknown): StepOutcome {
    if (error instanceof StepFailure || error instanceof RenderError) return { type: 'fail', error: error.message }

    const retryable = !(error instanceof PlatformError) || error.retryable
    const reason = error instanceof Error ? error.message : 'step failed'
    if (!retryable) return { type: 'fail', error: reason }
    if (claimed.attempt >= maxAttempts(claimed.step)) {
      // start в Dokploy ждёт, пока сервис сойдётся: робот, падающий при запуске, не сходится никогда
      const hint = claimed.step === SagaStep.START ? '; the robot may be crashing on start, see its logs in Dokploy' : ''
      return { type: 'fail', error: `${reason} (gave up after ${claimed.attempt} attempts)${hint}` }
    }
    // Не ошибка Dokploy — база, расшифровка или баг: в лог с именем, без содержимого
    if (!(error instanceof PlatformError)) {
      this.logger.error({ err: error, operationId: claimed.operationId, step: claimed.step }, 'saga step failed unexpectedly')
    }

    const retryAfterMs = error instanceof PlatformError ? error.retryAfterMs : undefined
    return { type: 'retry', delayMs: retryDelayMs(claimed.attempt, Math.random, retryAfterMs), reason }
  }

  private async apply(claimed: ClaimedStep, outcome: StepOutcome): Promise<void> {
    const command = (step: SagaStep) => ({
      operationId: claimed.operationId,
      deploymentId: claimed.deploymentId,
      kind: claimed.kind,
      step,
    })

    await this.unitOfWork.run(async () => {
      switch (outcome.type) {
        case 'next': {
          const next = nextStep(claimed.kind, claimed.step)
          if (next === null) {
            await this.finish(claimed, 'SUCCEEDED', null, outcome.dokployAppId)
            return
          }
          const appId = outcome.dokployAppId ?? undefined
          if (await this.store.advance(claimed, next, outcome.context, appId)) {
            await this.outbox.enqueue(OutboxTopic.OPERATION_STEP, command(next))
          }
          return
        }
        case 'wait':
        case 'retry': {
          const context = outcome.type === 'wait' ? outcome.context : claimed.context
          const wake = Bun.randomUUIDv7()
          if (await this.store.release(claimed, { ...context }, wake, { resetAttempts: outcome.type === 'wait' })) {
            await this.outbox.enqueue(OutboxTopic.OPERATION_STEP, { ...command(claimed.step), wake }, { delayMs: outcome.delayMs })
          }
          if (outcome.type === 'retry') {
            this.logger.warn(
              { operationId: claimed.operationId, step: claimed.step, attempt: claimed.attempt },
              `saga step will be retried: ${outcome.reason}`,
            )
          }
          return
        }
        case 'fail':
          await this.finish(claimed, 'FAILED', outcome.error, outcome.dokployAppId)
          return
      }
    })
  }

  private async finish(
    claimed: ClaimedStep,
    result: 'SUCCEEDED' | 'FAILED',
    error: string | null,
    dokployAppId: string | null | undefined,
  ): Promise<void> {
    const outcome = OUTCOME[claimed.kind]
    const finished = await this.store.finish(claimed, {
      operation: result,
      error,
      deploymentStatus: result === 'SUCCEEDED' ? outcome.succeeded : outcome.failed,
      ...(dokployAppId !== undefined && { dokployAppId }),
    })
    if (!finished) return

    await this.audit.record({
      actor: ACTOR,
      action: `deployment.${claimed.kind.toLowerCase()}_${result === 'SUCCEEDED' ? 'succeeded' : 'failed'}`,
      targetType: 'deployment',
      targetId: claimed.deploymentId,
      payload: { operationId: claimed.operationId, step: claimed.step, ...(error && { error }) },
    })
  }
}

function appIdOf(deployment: Deployment): string {
  if (!deployment.dokployAppId) throw new StepFailure('the deployment has no Dokploy application yet')

  return deployment.dokployAppId
}
