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
import { z } from 'zod'
import { ZodBody } from '../../../shared/http/zod-body'
import type { Operator } from '../../auth/domain/auth'
import { CurrentOperator } from '../../auth/presentation/session.guard'
import { DestinationUseCases } from '../application/destination-use-cases'
import { type Destination, DestinationError, DestinationErrorCode } from '../domain/destination'

// Не короче 16: подсказка показывает 4 последних символа, у короткого ключа это слишком большая доля
const apiKey = z.string().trim().min(16).max(512)
const dokployId = z.string().trim().min(1).max(128)

const previewSchema = z.object({ baseUrl: z.string().max(2048), apiKey })
const createSchema = z
  .object({
    name: z.string().max(200),
    baseUrl: z.string().max(2048),
    apiKey,
    environmentId: dokployId,
    serverId: dokployId.nullable().default(null),
  })
  .strict()
const updateSchema = z
  .object({
    version: z.number().int().positive(),
    name: z.string().max(200).optional(),
    baseUrl: z.string().max(2048).optional(),
    apiKey: apiKey.optional(),
    environmentId: dokployId.optional(),
    serverId: dokployId.nullable().optional(),
  })
  .strict()
const versionSchema = z.object({ version: z.number().int().positive() })

/** Назначение наружу: без конверта ключа, только подсказка */
export interface DestinationView {
  id: string
  name: string
  baseUrl: string
  apiKeyHint: string
  projectId: string
  environmentId: string
  serverId: string | null
  status: Destination['status']
  lastCheckedAt: string | null
  lastError: string | null
  version: number
  createdAt: string
  updatedAt: string
}

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
  preview(@Body(new ZodBody(previewSchema)) body: z.infer<typeof previewSchema>) {
    return http(this.destinations.preview(body.baseUrl, body.apiKey))
  }

  @Post()
  async create(
    @Body(new ZodBody(createSchema)) body: z.infer<typeof createSchema>,
    @CurrentOperator() operator: Operator,
  ): Promise<DestinationView> {
    return view(await http(this.destinations.create(body, actor(operator))))
  }

  @Patch(':id')
  async update(
    @Param('id', DESTINATION_ID) id: string,
    @Body(new ZodBody(updateSchema)) body: z.infer<typeof updateSchema>,
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
    @Body(new ZodBody(versionSchema)) body: z.infer<typeof versionSchema>,
    @CurrentOperator() operator: Operator,
  ): Promise<DestinationView> {
    return view(await http(this.destinations.setEnabled(id, body.version, false, actor(operator))))
  }

  @Post(':id/enable')
  @HttpCode(HttpStatus.OK)
  async enable(
    @Param('id', DESTINATION_ID) id: string,
    @Body(new ZodBody(versionSchema)) body: z.infer<typeof versionSchema>,
    @CurrentOperator() operator: Operator,
  ): Promise<DestinationView> {
    return view(await http(this.destinations.setEnabled(id, body.version, true, actor(operator))))
  }
}
