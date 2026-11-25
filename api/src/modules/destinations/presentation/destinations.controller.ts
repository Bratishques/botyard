import {
  type DestinationCreateBody,
  type DestinationPreviewBody,
  type DestinationPreviewView,
  type DestinationUpdateBody,
  type DestinationView,
  destinationCreateSchema,
  destinationPreviewSchema,
  destinationUpdateSchema,
  type VersionBody,
  versionSchema,
} from '@botyard/contract'
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common'
import { ZodBody } from '../../../shared/http/zod-body'
import type { Operator } from '../../auth/domain/auth'
import { CurrentOperator } from '../../auth/presentation/session.guard'
import { DestinationUseCases } from '../application/destination-use-cases'
import { type Destination, DestinationError, DestinationErrorCode } from '../domain/destination'

function view(destination: Destination): DestinationView {
  return {
    id: destination.id,
    name: destination.name,
    baseUrl: destination.baseUrl,
    apiKeyHint: destination.apiKeyHint,
    projectId: destination.projectId,
    environmentId: destination.environmentId,
    serverId: destination.serverId,
    status: destination.status,
    lastCheckedAt: destination.lastCheckedAt?.toISOString() ?? null,
    lastError: destination.lastError,
    version: destination.version,
    createdAt: destination.createdAt.toISOString(),
    updatedAt: destination.updatedAt.toISOString(),
  }
}

const STATUS: Record<DestinationErrorCode, new (body: object) => HttpException> = {
  [DestinationErrorCode.NOT_FOUND]: NotFoundException,
  [DestinationErrorCode.NAME_TAKEN]: ConflictException,
  [DestinationErrorCode.TARGET_TAKEN]: ConflictException,
  [DestinationErrorCode.VERSION_CONFLICT]: ConflictException,
  [DestinationErrorCode.HAS_DEPLOYMENTS]: ConflictException,
  [DestinationErrorCode.KEY_CANNOT_SEE_DEPLOYMENTS]: UnprocessableEntityException,
  [DestinationErrorCode.INVALID_URL]: BadRequestException,
  [DestinationErrorCode.INVALID_NAME]: BadRequestException,
  [DestinationErrorCode.INSECURE_URL]: BadRequestException,
  [DestinationErrorCode.KEY_REQUIRED]: BadRequestException,
  [DestinationErrorCode.KEY_REJECTED]: UnprocessableEntityException,
  [DestinationErrorCode.ENVIRONMENT_NOT_FOUND]: UnprocessableEntityException,
  [DestinationErrorCode.SERVER_NOT_FOUND]: UnprocessableEntityException,
  [DestinationErrorCode.UNREACHABLE]: ServiceUnavailableException,
  [DestinationErrorCode.RATE_LIMITED]: ServiceUnavailableException,
}

/** Доменная ошибка → HTTP с кодом из контракта; прочее — как есть (фильтр сделает 500) */
async function http<T>(work: Promise<T>): Promise<T> {
  try {
    return await work
  } catch (error) {
    if (error instanceof DestinationError) throw new STATUS[error.code]({ code: error.code, message: error.message })
    throw error
  }
}

const actor = (operator: Operator) => `operator:${operator.id}`

/** id назначения — uuid; ошибка в формате контракта, а не текстом Nest */
const DESTINATION_ID = new ParseUUIDPipe({
  exceptionFactory: () => new BadRequestException({ code: 'VALIDATION_FAILED', message: 'id: must be a uuid' }),
})

@Controller('destinations')
export class DestinationsController {
  constructor(private readonly destinations: DestinationUseCases) {}

  @Get()
  async list(): Promise<DestinationView[]> {
    return (await this.destinations.list()).map(view)
  }

  @Get(':id')
  async get(@Param('id', DESTINATION_ID) id: string): Promise<DestinationView> {
    return view(await http(this.destinations.get(id)))
  }

  /** Окружения и серверы по адресу и ключу — до сохранения, чтобы оператор выбрал окружение */
  @Post('preview')
  @HttpCode(HttpStatus.OK)
  preview(@Body(new ZodBody(destinationPreviewSchema)) body: DestinationPreviewBody): Promise<DestinationPreviewView> {
    return http(this.destinations.preview(body.baseUrl, body.apiKey))
  }

  @Post()
  async create(
    @Body(new ZodBody(destinationCreateSchema)) body: DestinationCreateBody,
    @CurrentOperator() operator: Operator,
  ): Promise<DestinationView> {
    return view(await http(this.destinations.create(body, actor(operator))))
  }

  @Patch(':id')
  async update(
    @Param('id', DESTINATION_ID) id: string,
    @Body(new ZodBody(destinationUpdateSchema)) body: DestinationUpdateBody,
    @CurrentOperator() operator: Operator,
  ): Promise<DestinationView> {
    return view(await http(this.destinations.update(id, body, actor(operator))))
  }

  @Post(':id/check')
  @HttpCode(HttpStatus.OK)
  async check(@Param('id', DESTINATION_ID) id: string, @CurrentOperator() operator: Operator): Promise<DestinationView> {
    return view(await http(this.destinations.check(id, actor(operator))))
  }

  @Post(':id/disable')
  @HttpCode(HttpStatus.OK)
  async disable(
    @Param('id', DESTINATION_ID) id: string,
    @Body(new ZodBody(versionSchema)) body: VersionBody,
    @CurrentOperator() operator: Operator,
  ): Promise<DestinationView> {
    return view(await http(this.destinations.setEnabled(id, body.version, false, actor(operator))))
  }

  @Post(':id/enable')
  @HttpCode(HttpStatus.OK)
  async enable(
    @Param('id', DESTINATION_ID) id: string,
    @Body(new ZodBody(versionSchema)) body: VersionBody,
    @CurrentOperator() operator: Operator,
  ): Promise<DestinationView> {
    return view(await http(this.destinations.setEnabled(id, body.version, true, actor(operator))))
  }
}
