import { Module } from '@nestjs/common'
import { READINESS_CHECKS, type ReadinessCheck } from './domain/readiness-check'
import { PostgresReadiness } from './infrastructure/postgres.readiness'
import { HealthController } from './presentation/health.controller'

@Module({
  controllers: [HealthController],
  providers: [
    PostgresReadiness,
    { provide: READINESS_CHECKS, inject: [PostgresReadiness], useFactory: (postgres: PostgresReadiness): ReadinessCheck[] => [postgres] },
  ],
})
export class HealthModule {}
