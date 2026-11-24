import { type DynamicModule, type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common'
import { LoggerModule } from 'nestjs-pino'
import { AuthModule } from './modules/auth/auth.module'
import { DestinationsModule } from './modules/destinations/destinations.module'
import { HealthModule } from './modules/health/health.module'
import { AuditModule } from './shared/audit/audit'
import type { AppConfig } from './shared/config/config'
import { ConfigModule } from './shared/config/config.module'
import { CryptoModule } from './shared/crypto/crypto.module'
import { DatabaseModule } from './shared/database/database.module'
import { DokployModule } from './shared/dokploy/dokploy.module'
import { HttpMetricsMiddleware } from './shared/observability/http-metrics.middleware'
import { loggerOptions } from './shared/observability/logger'
import { MetricsServer } from './shared/observability/metrics'

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
        HealthModule,
        AuthModule,
        DestinationsModule,
      ],
      providers: [MetricsServer],
    }
  }

  configure(consumer: MiddlewareConsumer): void {
    // `{*path}` — включая корень `/`: шаблон `*path` требует хотя бы один сегмент
    consumer.apply(HttpMetricsMiddleware).forRoutes('{*path}')
  }
}
