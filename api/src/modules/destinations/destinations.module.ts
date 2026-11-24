import { Module } from '@nestjs/common'
import { DestinationSecrets } from './application/destination-secrets'
import { DestinationUseCases } from './application/destination-use-cases'
import { DESTINATION_REPOSITORY, DOKPLOY_CATALOG } from './domain/ports'
import { DokployCatalogAdapter } from './infrastructure/dokploy-catalog.adapter'
import { PostgresDestinationRepository } from './infrastructure/postgres-destination.repository'
import { DestinationsController } from './presentation/destinations.controller'

@Module({
  controllers: [DestinationsController],
  providers: [
    { provide: DESTINATION_REPOSITORY, useClass: PostgresDestinationRepository },
    { provide: DOKPLOY_CATALOG, useClass: DokployCatalogAdapter },
    DestinationSecrets,
    DestinationUseCases,
  ],
  exports: [DestinationUseCases],
})
export class DestinationsModule {}
