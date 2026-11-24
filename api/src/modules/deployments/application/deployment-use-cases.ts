import { Inject, Injectable } from '@nestjs/common'
import type { ValidateFunction } from 'ajv'
import { AuditLog } from '../../../shared/audit/audit'
import { configSchemaValidator } from '../../../shared/catalog/config-validator'
import { UnitOfWork } from '../../../shared/database/unit-of-work'
import { Outbox, OutboxTopic } from '../../../shared/outbox/outbox'
import { modeOf } from '../../customers/domain/customer'
import {
  appNameOf,
  DEPLOYMENT_REPOSITORY,
  type Deployment,
  DeploymentError,
  DeploymentErrorCode,
  type DeploymentRepository,
  OPERATION_RULES,
  type Operation,
  type OperationKind,
} from '../domain/deployment'

export interface CreateDeploymentInput {
  readonly customerId: string
  readonly destinationId: string
  readonly templateId: string
  readonly config: Record<string, unknown>
}

/**
 * Сценарии развёртываний. Здесь — только решение и запись: состояние, операция и команда в outbox пишутся
 * одной транзакцией, а саму работу (вызовы Dokploy) делает воркер саги по команде из очереди (этап 2, шаг 3).
 * Поэтому запрос оператора не ждёт Dokploy и не держит транзакцию на сетевом вызове.
 */
@Injectable()
export class DeploymentUseCases {
  constructor(
    @Inject(DEPLOYMENT_REPOSITORY) private readonly repository: DeploymentRepository,
    private readonly unitOfWork: UnitOfWork,
    private readonly outbox: Outbox,
    private readonly audit: AuditLog,
  ) {}

  list(): Promise<Deployment[]> {
    return this.repository.list()
  }

  async get(id: string): Promise<{ deployment: Deployment; operations: Operation[] }> {
    const deployment = (await this.repository.findById(id)) ?? notFound(id)

    return { deployment, operations: await this.repository.operations(id) }
  }

  /**
   * Новое развёртывание. Основание (клиент, назначение, шаблон) читается под блокировкой в той же
   * транзакции: архивация клиента или выключение назначения не проскочат между проверкой и записью.
   */
  create(input: CreateDeploymentInput, actor: string): Promise<{ deployment: Deployment; operation: Operation }> {
    return this.unitOfWork.run(async () => {
      const basis = await this.repository.lockBasis(input.customerId, input.destinationId, input.templateId)
      if (basis.customer?.status !== 'ACTIVE') {
        throw new DeploymentError(DeploymentErrorCode.CUSTOMER_UNAVAILABLE, 'customer is missing or archived')
      }
      if (!basis.destination || basis.destination.status === 'DISABLED') {
        throw new DeploymentError(DeploymentErrorCode.DESTINATION_UNAVAILABLE, 'destination is missing or disabled')
      }
      if (!basis.template || basis.template.retired) {
        throw new DeploymentError(DeploymentErrorCode.TEMPLATE_UNAVAILABLE, 'template is missing or retired')
      }

      const config = validateConfig(`${basis.template.id}@${basis.template.currentVersion}`, basis.template.configSchema, input.config)
      const id = Bun.randomUUIDv7()
      const operationId = Bun.randomUUIDv7()

      // Операция ссылается на развёртывание, развёртывание — на активную операцию (отложенный FK)
      const deployment = await this.repository.insert({
        id,
        customerId: input.customerId,
        destinationId: input.destinationId,
        templateId: basis.template.id,
        templateVersion: basis.template.currentVersion,
        config,
        tradingMode: modeOf(basis.customer),
        appName: appNameOf(id),
        status: 'PROVISIONING',
        activeOperationId: operationId,
      })
      const operation = await this.repository.insertOperation({ id: operationId, deploymentId: id, kind: 'PROVISION', requestedBy: actor })
      await this.outbox.enqueue(OutboxTopic.OPERATION_STEP, { operationId, deploymentId: id, kind: 'PROVISION' })
      await this.audit.record({
        actor,
        action: 'deployment.created',
        targetType: 'deployment',
        targetId: id,
        payload: {
          customerId: input.customerId,
          destinationId: input.destinationId,
          templateId: basis.template.id,
          templateVersion: basis.template.currentVersion,
          appName: deployment.appName,
          tradingMode: deployment.tradingMode,
          operationId,
        },
      })

      return { deployment, operation }
    })
  }

  /**
   * Операция над существующим развёртыванием: захват единственной активной операции условной записью.
   * Назначение проверяется после захвата, под FOR SHARE в той же транзакции: выключение, начатое раньше,
   * будет дождано и увидено, а начатое позже дождётся этой транзакции. Запуск, принятый до выключения,
   * воркер ещё раз сверит с назначением перед вызовом Dokploy (этап 2, шаг 3).
   */
  operate(
    id: string,
    kind: Exclude<OperationKind, 'PROVISION'>,
    version: number,
    actor: string,
  ): Promise<{ deployment: Deployment; operation: Operation }> {
    const rule = OPERATION_RULES[kind]

    return this.unitOfWork.run(async () => {
      const operationId = Bun.randomUUIDv7()
      const claimed = await this.repository.claim(id, version, operationId, rule.from, rule.claimAs)
      if (!claimed) throw await this.whyNotClaimed(id, version, rule.from)
      if (rule.requiresActiveDestination && (await this.repository.lockDestinationStatus(claimed.destinationId)) === 'DISABLED') {
        throw new DeploymentError(DeploymentErrorCode.DESTINATION_UNAVAILABLE, 'destination is disabled: only stop and delete are allowed')
      }

      const operation = await this.repository.insertOperation({ id: operationId, deploymentId: id, kind, requestedBy: actor })
      await this.outbox.enqueue(OutboxTopic.OPERATION_STEP, { operationId, deploymentId: id, kind })
      await this.audit.record({
        actor,
        action: `deployment.${kind.toLowerCase()}_requested`,
        targetType: 'deployment',
        targetId: id,
        payload: { operationId, version: claimed.version },
      })

      return { deployment: claimed, operation }
    })
  }

  /** Условная запись не прошла — объяснить почему, по свежему состоянию */
  private async whyNotClaimed(id: string, version: number, from: readonly string[]): Promise<DeploymentError> {
    const current = await this.repository.findById(id)
    if (!current) return new DeploymentError(DeploymentErrorCode.NOT_FOUND, `deployment ${id} is not found`)
    if (current.activeOperationId !== null) {
      return new DeploymentError(DeploymentErrorCode.OPERATION_IN_PROGRESS, 'another operation is in progress, wait for it to finish')
    }
    if (current.version !== version)
      return new DeploymentError(DeploymentErrorCode.VERSION_CONFLICT, `deployment ${id} was changed, reload and retry`)
    if (!from.includes(current.status)) {
      return new DeploymentError(DeploymentErrorCode.INVALID_STATE, `operation is not allowed in status ${current.status}`)
    }

    return new DeploymentError(DeploymentErrorCode.VERSION_CONFLICT, `deployment ${id} was changed, reload and retry`)
  }
}

/** Скомпилированные схемы конфига по `шаблон@версия`: версия шаблона неизменяема, кеш не устаревает */
const validators = new Map<string, ValidateFunction>()

/** Конфиг по схеме шаблона: копия с подставленными `default`; ошибки — пути полей, без значений */
function validateConfig(versionKey: string, schema: Record<string, unknown>, input: Record<string, unknown>): Record<string, unknown> {
  const config = structuredClone(input)
  let validate = validators.get(versionKey)
  if (!validate) {
    validate = configSchemaValidator({ useDefaults: true }).compile(schema)
    validators.set(versionKey, validate)
  }
  if (!validate(config)) {
    const problems = (validate.errors ?? []).map((error) => `${error.instancePath || 'config'} ${error.message ?? 'is invalid'}`)
    throw new DeploymentError(DeploymentErrorCode.INVALID_CONFIG, problems.join('; '))
  }

  return config
}

function notFound(id: string): never {
  throw new DeploymentError(DeploymentErrorCode.NOT_FOUND, `deployment ${id} is not found`)
}
