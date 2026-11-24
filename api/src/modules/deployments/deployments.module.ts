import { Module } from '@nestjs/common'
import { CatalogModule } from '../catalog/catalog.module'
import { CustomersModule } from '../customers/customers.module'
import { DestinationsModule } from '../destinations/destinations.module'
import { DeploymentUseCases } from './application/deployment-use-cases'
import { OperationWorker } from './application/operation-worker'
import { DEPLOYMENT_REPOSITORY } from './domain/deployment'
import { DEPLOYMENT_PLATFORM } from './domain/deployment-platform'
import { OPERATION_STORE } from './domain/operation-store'
import { CONFIG_RENDERER } from './domain/robot-runtime'
import { DokployDeploymentPlatform } from './infrastructure/dokploy-deployment.platform'
import { HandlebarsConfigRenderer } from './infrastructure/handlebars-config.renderer'
import { PostgresDeploymentRepository } from './infrastructure/postgres-deployment.repository'
import { PostgresOperationStore } from './infrastructure/postgres-operation.store'
import { DeploymentsController } from './presentation/deployments.controller'

@Module({
  imports: [CatalogModule, CustomersModule, DestinationsModule],
  controllers: [DeploymentsController],
  providers: [
    { provide: DEPLOYMENT_REPOSITORY, useClass: PostgresDeploymentRepository },
    { provide: OPERATION_STORE, useClass: PostgresOperationStore },
    { provide: DEPLOYMENT_PLATFORM, useClass: DokployDeploymentPlatform },
    { provide: CONFIG_RENDERER, useClass: HandlebarsConfigRenderer },
    DeploymentUseCases,
    OperationWorker,
  ],
  exports: [DeploymentUseCases, OperationWorker],
})
export class DeploymentsModule {}
