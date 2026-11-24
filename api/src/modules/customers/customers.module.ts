import { Module } from '@nestjs/common'
import { CustomerUseCases } from './application/customer-use-cases'
import { CUSTOMER_REPOSITORY } from './domain/customer'
import { PostgresCustomerRepository } from './infrastructure/postgres-customer.repository'
import { CustomersController } from './presentation/customers.controller'

@Module({
  controllers: [CustomersController],
  providers: [{ provide: CUSTOMER_REPOSITORY, useClass: PostgresCustomerRepository }, CustomerUseCases],
  exports: [CustomerUseCases],
})
export class CustomersModule {}
