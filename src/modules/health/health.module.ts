import { Module } from '@nestjs/common'
import { DB, type Db, pingDb } from '../../shared/database/database'
import { READINESS_CHECKS, type ReadinessCheck } from './domain/readiness-check'
import { HealthController } from './presentation/health.controller'

@Module({
  controllers: [HealthController],
  providers: [
    {
      provide: READINESS_CHECKS,
      inject: [DB],
      useFactory: (db: Db): ReadinessCheck[] => [{ name: 'postgres', probe: () => pingDb(db) }],
    },
  ],
})
export class HealthModule {}
