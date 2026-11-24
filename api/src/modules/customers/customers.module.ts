import { Module } from '@nestjs/common'
import { APP_CONFIG, type AppConfig } from '../../shared/config/config'
import { DEFAULT_TINVEST_CLIENT, TInvestClient } from '../../shared/tinvest/tinvest.client'
import { CustomerUseCases } from './application/customer-use-cases'
import { CUSTOMER_REPOSITORY } from './domain/customer'
import { TRADING_ACCOUNTS } from './domain/trading-accounts'
import { PostgresCustomerRepository } from './infrastructure/postgres-customer.repository'
import { DisabledTradingAccounts, TInvestTradingAccounts } from './infrastructure/tinvest-trading-accounts'
import { CustomersController } from './presentation/customers.controller'

@Module({
  controllers: [CustomersController],
  providers: [
    { provide: CUSTOMER_REPOSITORY, useClass: PostgresCustomerRepository },
    {
      provide: TRADING_ACCOUNTS,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        config.TINVEST_VERIFY_TOKENS
          ? new TInvestTradingAccounts(new TInvestClient(DEFAULT_TINVEST_CLIENT))
          : new DisabledTradingAccounts(),
    },
    CustomerUseCases,
  ],
  exports: [CustomerUseCases],
})
export class CustomersModule {}
