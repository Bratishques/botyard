import { Module } from '@nestjs/common'
import { DestinationSecrets } from './application/destination-secrets'
import { DestinationUseCases } from './application/destination-use-cases'
import { DestinationWebhooks } from './application/destination-webhooks'
import { DESTINATION_REPOSITORY, DOKPLOY_CATALOG } from './domain/ports'
import { DESTINATION_WEBHOOK_REPOSITORY, DOKPLOY_NOTIFICATIONS } from './domain/webhook'
import { DokployCatalogAdapter } from './infrastructure/dokploy-catalog.adapter'
import { DokployNotificationsAdapter } from './infrastructure/dokploy-notifications.adapter'
import { PostgresDestinationRepository } from './infrastructure/postgres-destination.repository'
import { PostgresDestinationWebhookRepository } from './infrastructure/postgres-destination-webhook.repository'
import { DestinationsController } from './presentation/destinations.controller'

@Module({
  controllers: [DestinationsController],
  providers: [
    { provide: DESTINATION_REPOSITORY, useClass: PostgresDestinationRepository },
    { provide: DOKPLOY_CATALOG, useClass: DokployCatalogAdapter },
    { provide: DESTINATION_WEBHOOK_REPOSITORY, useClass: PostgresDestinationWebhookRepository },
    { provide: DOKPLOY_NOTIFICATIONS, useClass: DokployNotificationsAdapter },
    DestinationSecrets,
    DestinationWebhooks,
    DestinationUseCases,
  ],
  exports: [DestinationUseCases, DestinationWebhooks],
})
export class DestinationsModule {}
