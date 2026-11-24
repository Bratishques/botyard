import { Module } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { AuthService } from './application/auth.service'
import { LOGIN_THROTTLE, OPERATOR_REPOSITORY, SESSION_REPOSITORY } from './domain/auth'
import { MemoryLoginThrottle } from './infrastructure/memory-login-throttle'
import { PostgresOperatorRepository, PostgresSessionRepository } from './infrastructure/postgres-auth.repositories'
import { AuthController } from './presentation/auth.controller'
import { SessionGuard } from './presentation/session.guard'
import { SessionStreams } from './presentation/session-streams'

@Module({
  controllers: [AuthController],
  providers: [
    { provide: OPERATOR_REPOSITORY, useClass: PostgresOperatorRepository },
    { provide: SESSION_REPOSITORY, useClass: PostgresSessionRepository },
    { provide: LOGIN_THROTTLE, useFactory: () => new MemoryLoginThrottle() },
    AuthService,
    SessionStreams,
    { provide: APP_GUARD, useClass: SessionGuard },
  ],
  exports: [AuthService, SessionStreams],
})
export class AuthModule {}
