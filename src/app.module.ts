import { type DynamicModule, type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common'
import { LoggerModule } from 'nestjs-pino'
import { HealthModule } from './modules/health/health.module'
import type { AppConfig } from './shared/config/config'
import { ConfigModule } from './shared/config/config.module'
import { DatabaseModule } from './shared/database/database.module'
import { HttpMetricsMiddleware } from './shared/observability/http-metrics.middleware'
import { loggerOptions } from './shared/observability/logger'

@Module({})
export class AppModule implements NestModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [ConfigModule.forRoot(config), LoggerModule.forRoot(loggerOptions(config)), DatabaseModule, HealthModule],
    }
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(HttpMetricsMiddleware).forRoutes('*path')
  }
}
