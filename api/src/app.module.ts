import { type DynamicModule, type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common'
import { LoggerModule } from 'nestjs-pino'
import { AuthModule } from './modules/auth/auth.module'
import { CatalogModule } from './modules/catalog/catalog.module'
import { CustomersModule } from './modules/customers/customers.module'
import { DeploymentsModule } from './modules/deployments/deployments.module'
import { DestinationsModule } from './modules/destinations/destinations.module'
import { HealthModule } from './modules/health/health.module'
import { AuditModule } from './shared/audit/audit'
import type { AppConfig } from './shared/config/config'
import { ConfigModule } from './shared/config/config.module'
import { CryptoModule } from './shared/crypto/crypto.module'
import { DatabaseModule } from './shared/database/database.module'
import { DokployModule } from './shared/dokploy/dokploy.module'
import { IdempotencyModule } from './shared/idempotency/idempotency'
import { HttpMetricsMiddleware } from './shared/observability/http-metrics.middleware'
import { loggerOptions } from './shared/observability/logger'
import { MetricsServer } from './shared/observability/metrics'
import { OutboxModule } from './shared/outbox/outbox'

@Module({})
export class AppModule implements NestModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(config),
        LoggerModule.forRoot(loggerOptions(config)),
        DatabaseModule,
        CryptoModule,
        AuditModule,
        DokployModule,
        OutboxModule,
        IdempotencyModule,
        HealthModule,
        AuthModule,
        DestinationsModule,
        CatalogModule,
        CustomersModule,
        DeploymentsModule,
      ],
      providers: [MetricsServer],
    }
  }

  configure(consumer: MiddlewareConsumer): void {
    // `{*path}` — включая корень `/`: шаблон `*path` требует хотя бы один сегмент
    consumer.apply(HttpMetricsMiddleware).forRoutes('{*path}')
  }
}
