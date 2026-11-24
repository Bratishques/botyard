import { Module } from '@nestjs/common'
import { DEFAULT_DOKPLOY_CLIENT, DokployClient } from '../../shared/dokploy/dokploy.client'
import { DestinationSecrets } from './application/destination-secrets'
import { DestinationUseCases } from './application/destination-use-cases'
import { DESTINATION_REPOSITORY, DOKPLOY_CATALOG } from './domain/ports'
import { DokployCatalogAdapter } from './infrastructure/dokploy-catalog.adapter'
import { KyselyDestinationRepository } from './infrastructure/kysely-destination.repository'

@Module({
  providers: [
    { provide: DokployClient, useFactory: () => new DokployClient(DEFAULT_DOKPLOY_CLIENT) },
    { provide: DESTINATION_REPOSITORY, useClass: KyselyDestinationRepository },
    { provide: DOKPLOY_CATALOG, useClass: DokployCatalogAdapter },
    DestinationSecrets,
    DestinationUseCases,
  ],
  exports: [DestinationUseCases],
})
export class DestinationsModule {}
