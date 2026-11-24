import {
  type CustomerCreateBody,
  type CustomerLiveBody,
  type CustomerSandboxBody,
  type CustomerTokenBody,
  type CustomerUpdateBody,
  type CustomerView,
  customerCreateSchema,
  customerLiveSchema,
  customerSandboxSchema,
  customerTokenSchema,
  customerUpdateSchema,
  type VersionBody,
  versionSchema,
} from '@botyard/contract'
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
import { ZodBody } from '../../../shared/http/zod-body'
import type { Operator } from '../../auth/domain/auth'
import { CurrentOperator } from '../../auth/presentation/session.guard'
import { CustomerUseCases } from '../application/customer-use-cases'
import { type Customer, CustomerError, CustomerErrorCode, modeOf } from '../domain/customer'

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
  [CustomerErrorCode.TOKEN_REJECTED]: HttpStatus.UNPROCESSABLE_ENTITY,
  [CustomerErrorCode.ACCOUNT_NOT_FOUND]: HttpStatus.UNPROCESSABLE_ENTITY,
  [CustomerErrorCode.TOKEN_READ_ONLY]: HttpStatus.UNPROCESSABLE_ENTITY,
  [CustomerErrorCode.ACCOUNT_NOT_TRADABLE]: HttpStatus.UNPROCESSABLE_ENTITY,
  [CustomerErrorCode.LIVE_TOKEN_IN_SANDBOX]: HttpStatus.UNPROCESSABLE_ENTITY,
  [CustomerErrorCode.LIVE_CHECK_DISABLED]: HttpStatus.CONFLICT,
  [CustomerErrorCode.BROKER_UNAVAILABLE]: HttpStatus.SERVICE_UNAVAILABLE,
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
  async create(@Body(new ZodBody(customerCreateSchema)) body: CustomerCreateBody, @CurrentOperator() operator: Operator) {
    return view(await http(this.customers.create(body, actor(operator))))
  }

  @Patch(':id')
  async update(
    @Param('id', CUSTOMER_ID) id: string,
    @Body(new ZodBody(customerUpdateSchema)) body: CustomerUpdateBody,
    @CurrentOperator() operator: Operator,
  ) {
    return view(await http(this.customers.update(id, body, actor(operator))))
  }

  @Post(':id/token')
  @HttpCode(HttpStatus.OK)
  async rotateToken(
    @Param('id', CUSTOMER_ID) id: string,
    @Body(new ZodBody(customerTokenSchema)) body: CustomerTokenBody,
    @CurrentOperator() operator: Operator,
  ) {
    return view(await http(this.customers.rotateToken(id, body, actor(operator))))
  }

  @Post(':id/live')
  @HttpCode(HttpStatus.OK)
  async goLive(
    @Param('id', CUSTOMER_ID) id: string,
    @Body(new ZodBody(customerLiveSchema)) body: CustomerLiveBody,
    @CurrentOperator() operator: Operator,
  ) {
    return view(await http(this.customers.goLive(id, body, actor(operator))))
  }

  @Post(':id/sandbox')
  @HttpCode(HttpStatus.OK)
  async goSandbox(
    @Param('id', CUSTOMER_ID) id: string,
    @Body(new ZodBody(customerSandboxSchema)) body: CustomerSandboxBody,
    @CurrentOperator() operator: Operator,
  ) {
    return view(await http(this.customers.goSandbox(id, body, actor(operator))))
  }

  @Post(':id/archive')
  @HttpCode(HttpStatus.OK)
  async archive(
    @Param('id', CUSTOMER_ID) id: string,
    @Body(new ZodBody(versionSchema)) body: VersionBody,
    @CurrentOperator() operator: Operator,
  ) {
    return view(await http(this.customers.archive(id, body.version, actor(operator))))
  }
}
