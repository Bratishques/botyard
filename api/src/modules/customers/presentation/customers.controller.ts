import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common'
import { z } from 'zod'
import { ZodBody } from '../../../shared/http/zod-body'
import type { Operator } from '../../auth/domain/auth'
import { CurrentOperator } from '../../auth/presentation/session.guard'
import { CustomerUseCases } from '../application/customer-use-cases'
import { type Customer, CustomerError, CustomerErrorCode, modeOf, type TradingMode } from '../domain/customer'

// Токены T-Invest длинные (t.…); короче 16 — заведомо не токен, а подсказка открыла бы большую его долю
const token = z.string().trim().min(16).max(512)
const version = z.number().int().positive()

const createSchema = z.object({ name: z.string().max(200), accountId: z.string().max(100), token }).strict()
const updateSchema = z
  .object({
    version,
    name: z.string().max(200).optional(),
    accountId: z.string().max(100).optional(),
    confirmName: z.string().max(200).optional(),
  })
  .strict()
const tokenSchema = z.object({ version, token }).strict()
const liveSchema = z.object({ version, token, accountId: z.string().max(100), confirmName: z.string().max(200) }).strict()
const sandboxSchema = z.object({ version, token, accountId: z.string().max(100) }).strict()
const versionSchema = z.object({ version }).strict()

/** Клиент наружу: без конверта токена, только подсказка */
export interface CustomerView {
  id: string
  name: string
  accountId: string
  tokenHint: string
  mode: TradingMode
  status: Customer['status']
  version: number
  createdAt: string
  updatedAt: string
}

function view(customer: Customer): CustomerView {
  return {
    id: customer.id,
    name: customer.name,
    accountId: customer.accountId,
    tokenHint: customer.tokenHint,
    mode: modeOf(customer),
    status: customer.status,
    version: customer.version,
    createdAt: customer.createdAt.toISOString(),
    updatedAt: customer.updatedAt.toISOString(),
  }
}

const STATUS: Record<CustomerErrorCode, number> = {
  [CustomerErrorCode.NOT_FOUND]: HttpStatus.NOT_FOUND,
  [CustomerErrorCode.NAME_TAKEN]: HttpStatus.CONFLICT,
  [CustomerErrorCode.VERSION_CONFLICT]: HttpStatus.CONFLICT,
  [CustomerErrorCode.ALREADY_IN_MODE]: HttpStatus.CONFLICT,
  [CustomerErrorCode.ARCHIVED]: HttpStatus.CONFLICT,
  [CustomerErrorCode.HAS_DEPLOYMENTS]: HttpStatus.CONFLICT,
  [CustomerErrorCode.INVALID_NAME]: HttpStatus.BAD_REQUEST,
  [CustomerErrorCode.INVALID_ACCOUNT]: HttpStatus.BAD_REQUEST,
  [CustomerErrorCode.LIVE_CONFIRMATION_REQUIRED]: HttpStatus.UNPROCESSABLE_ENTITY,
}

async function http<T>(work: Promise<T>): Promise<T> {
  try {
    return await work
  } catch (error) {
    if (error instanceof CustomerError) throw new HttpException({ code: error.code, message: error.message }, STATUS[error.code])
    throw error
  }
}

const CUSTOMER_ID = new ParseUUIDPipe({
  exceptionFactory: () => new BadRequestException({ code: 'VALIDATION_FAILED', message: 'id: must be a uuid' }),
})

const actor = (operator: Operator) => `operator:${operator.id}`

@Controller('customers')
export class CustomersController {
  constructor(private readonly customers: CustomerUseCases) {}

  @Get()
  async list(): Promise<CustomerView[]> {
    return (await this.customers.list()).map(view)
  }

  @Get(':id')
  async get(@Param('id', CUSTOMER_ID) id: string): Promise<CustomerView> {
    return view(await http(this.customers.get(id)))
  }

  @Post()
  async create(@Body(new ZodBody(createSchema)) body: z.infer<typeof createSchema>, @CurrentOperator() operator: Operator) {
    return view(await http(this.customers.create(body, actor(operator))))
  }

  @Patch(':id')
  async update(
    @Param('id', CUSTOMER_ID) id: string,
    @Body(new ZodBody(updateSchema)) body: z.infer<typeof updateSchema>,
    @CurrentOperator() operator: Operator,
  ) {
    return view(await http(this.customers.update(id, body, actor(operator))))
  }

  @Post(':id/token')
  @HttpCode(HttpStatus.OK)
  async rotateToken(
    @Param('id', CUSTOMER_ID) id: string,
    @Body(new ZodBody(tokenSchema)) body: z.infer<typeof tokenSchema>,
    @CurrentOperator() operator: Operator,
  ) {
    return view(await http(this.customers.rotateToken(id, body, actor(operator))))
  }

  @Post(':id/live')
  @HttpCode(HttpStatus.OK)
  async goLive(
    @Param('id', CUSTOMER_ID) id: string,
    @Body(new ZodBody(liveSchema)) body: z.infer<typeof liveSchema>,
    @CurrentOperator() operator: Operator,
  ) {
    return view(await http(this.customers.goLive(id, body, actor(operator))))
  }

  @Post(':id/sandbox')
  @HttpCode(HttpStatus.OK)
  async goSandbox(
    @Param('id', CUSTOMER_ID) id: string,
    @Body(new ZodBody(sandboxSchema)) body: z.infer<typeof sandboxSchema>,
    @CurrentOperator() operator: Operator,
  ) {
    return view(await http(this.customers.goSandbox(id, body, actor(operator))))
  }

  @Post(':id/archive')
  @HttpCode(HttpStatus.OK)
  async archive(
    @Param('id', CUSTOMER_ID) id: string,
    @Body(new ZodBody(versionSchema)) body: z.infer<typeof versionSchema>,
    @CurrentOperator() operator: Operator,
  ) {
    return view(await http(this.customers.archive(id, body.version, actor(operator))))
  }
}
