import {
  DEPLOYMENT_ACTIONS,
  type DeploymentCreateBody,
  type DeploymentView,
  deploymentCreateSchema,
  type OperationView,
  versionSchema,
} from '@botyard/contract'
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpException,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  type PipeTransform,
  Post,
  Res,
} from '@nestjs/common'
import type { Response } from 'express'
import { ZodBody } from '../../../shared/http/zod-body'
import { IDEMPOTENCY_KEY, Idempotency, IdempotencyConflictError, IdempotencyErrorCode } from '../../../shared/idempotency/idempotency'
import type { Operator } from '../../auth/domain/auth'
import { CurrentOperator } from '../../auth/presentation/session.guard'
import { DeploymentUseCases } from '../application/deployment-use-cases'
import { type Deployment, DeploymentError, DeploymentErrorCode, type Operation, type OperationKind } from '../domain/deployment'

const VERSION_BODY = new ZodBody(versionSchema)

function deploymentView(deployment: Deployment): DeploymentView {
  return {
    id: deployment.id,
    customerId: deployment.customerId,
    destinationId: deployment.destinationId,
    templateId: deployment.templateId,
    templateVersion: deployment.templateVersion,
    config: deployment.config,
    tradingMode: deployment.tradingMode,
    appName: deployment.appName,
    status: deployment.status,
    activeOperationId: deployment.activeOperationId,
    lastError: deployment.lastError,
    version: deployment.version,
    createdAt: deployment.createdAt.toISOString(),
    updatedAt: deployment.updatedAt.toISOString(),
  }
}

function operationView(operation: Operation): OperationView {
  return {
    id: operation.id,
    kind: operation.kind,
    status: operation.status,
    step: operation.step,
    attempt: operation.attempt,
    error: operation.error,
    requestedBy: operation.requestedBy,
    createdAt: operation.createdAt.toISOString(),
    finishedAt: operation.finishedAt?.toISOString() ?? null,
  }
}

const STATUS: Record<DeploymentErrorCode, number> = {
  [DeploymentErrorCode.NOT_FOUND]: HttpStatus.NOT_FOUND,
  [DeploymentErrorCode.VERSION_CONFLICT]: HttpStatus.CONFLICT,
  [DeploymentErrorCode.OPERATION_IN_PROGRESS]: HttpStatus.CONFLICT,
  [DeploymentErrorCode.INVALID_STATE]: HttpStatus.CONFLICT,
  [DeploymentErrorCode.INVALID_CONFIG]: HttpStatus.UNPROCESSABLE_ENTITY,
  [DeploymentErrorCode.CUSTOMER_UNAVAILABLE]: HttpStatus.UNPROCESSABLE_ENTITY,
  [DeploymentErrorCode.DESTINATION_UNAVAILABLE]: HttpStatus.UNPROCESSABLE_ENTITY,
  [DeploymentErrorCode.TEMPLATE_UNAVAILABLE]: HttpStatus.UNPROCESSABLE_ENTITY,
  [DeploymentErrorCode.TEMPLATE_NOT_LIVE_SAFE]: HttpStatus.UNPROCESSABLE_ENTITY,
}

async function http<T>(work: Promise<T>): Promise<T> {
  try {
    return await work
  } catch (error) {
    if (error instanceof DeploymentError) throw new HttpException({ code: error.code, message: error.message }, STATUS[error.code])
    if (error instanceof IdempotencyConflictError) {
      throw new HttpException({ code: IdempotencyErrorCode.CONFLICT, message: error.message }, HttpStatus.CONFLICT)
    }
    throw error
  }
}

function requireKey(key: string | undefined): string {
  if (!key || !IDEMPOTENCY_KEY.test(key)) {
    throw new BadRequestException({
      code: IdempotencyErrorCode.KEY_REQUIRED,
      message: 'Idempotency-Key header (8-128 of A-Z, a-z, 0-9, -, _) is required',
    })
  }

  return key
}

/** Действие из пути. Тело операции разбирается после него: неизвестное действие — 404 даже с невалидным телом */
const ACTION: PipeTransform<string, Exclude<OperationKind, 'PROVISION'>> = {
  transform(action) {
    const kind = ACTIONS[action]
    if (!kind) throw new NotFoundException({ code: 'NOT_FOUND', message: 'route not found' })
    return kind
  },
}

const DEPLOYMENT_ID = new ParseUUIDPipe({
  exceptionFactory: () => new BadRequestException({ code: 'VALIDATION_FAILED', message: 'id: must be a uuid' }),
})

const actor = (operator: Operator) => `operator:${operator.id}`

const ACTIONS: Readonly<Record<string, Exclude<OperationKind, 'PROVISION'>>> = Object.assign(Object.create(null), DEPLOYMENT_ACTIONS)

/**
 * Развёртывания. Изменяющие запросы требуют `Idempotency-Key`: двойной клик или повтор после обрыва
 * возвращают тот же ответ, а не создают второе развёртывание или вторую операцию.
 */
@Controller('deployments')
export class DeploymentsController {
  constructor(
    private readonly deployments: DeploymentUseCases,
    private readonly idempotency: Idempotency,
  ) {}

  @Get()
  async list(): Promise<DeploymentView[]> {
    return (await this.deployments.list()).map(deploymentView)
  }

  @Get(':id')
  async get(@Param('id', DEPLOYMENT_ID) id: string): Promise<DeploymentView & { operations: OperationView[] }> {
    const { deployment, operations } = await http(this.deployments.get(id))

    return { ...deploymentView(deployment), operations: operations.map(operationView) }
  }

  @Post()
  async create(
    @Body(new ZodBody(deploymentCreateSchema)) body: DeploymentCreateBody,
    @Headers('idempotency-key') key: string | undefined,
    @CurrentOperator() operator: Operator,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const result = await http(
      this.idempotency.run(`${actor(operator)}:deployments.create`, requireKey(key), body, async () => {
        const created = await this.deployments.create(body, actor(operator))
        return {
          statusCode: HttpStatus.CREATED,
          response: { ...deploymentView(created.deployment), operation: operationView(created.operation) },
        }
      }),
    )
    response.status(result.statusCode)

    return result.response
  }

  /** `POST /deployments/:id/{start|stop|redeploy|delete}` */
  @Post(':id/:action')
  async operate(
    @Param('id', DEPLOYMENT_ID) id: string,
    @Param('action', ACTION) kind: Exclude<OperationKind, 'PROVISION'>,
    @Body() raw: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @CurrentOperator() operator: Operator,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const body = VERSION_BODY.transform(raw)
    // Один scope на все операции развёртывания: тот же ключ для stop и start — 409, а не две операции
    const scope = `${actor(operator)}:deployments.${id}.operate`
    const result = await http(
      this.idempotency.run(scope, requireKey(key), { id, kind, version: body.version }, async () => {
        const { deployment, operation } = await this.deployments.operate(id, kind, body.version, actor(operator))
        return { statusCode: HttpStatus.ACCEPTED, response: { ...deploymentView(deployment), operation: operationView(operation) } }
      }),
    )
    response.status(result.statusCode)

    return result.response
  }
}
