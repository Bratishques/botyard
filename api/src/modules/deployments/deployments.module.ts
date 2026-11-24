import { Module } from '@nestjs/common'
import { DeploymentUseCases } from './application/deployment-use-cases'
import { DEPLOYMENT_REPOSITORY } from './domain/deployment'
import { PostgresDeploymentRepository } from './infrastructure/postgres-deployment.repository'
import { DeploymentsController } from './presentation/deployments.controller'

@Module({
  controllers: [DeploymentsController],
  providers: [{ provide: DEPLOYMENT_REPOSITORY, useClass: PostgresDeploymentRepository }, DeploymentUseCases],
  exports: [DeploymentUseCases],
})
export class DeploymentsModule {}
