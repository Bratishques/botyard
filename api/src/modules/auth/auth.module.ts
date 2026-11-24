import { Module } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { AuthService } from './application/auth.service'
import { AuthController } from './presentation/auth.controller'
import { SessionGuard } from './presentation/session.guard'

@Module({
  controllers: [AuthController],
  providers: [AuthService, { provide: APP_GUARD, useClass: SessionGuard }],
  exports: [AuthService],
})
export class AuthModule {}
