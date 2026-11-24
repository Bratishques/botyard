import { Global, Module } from '@nestjs/common'
import { DEFAULT_DOKPLOY_CLIENT, DokployClient } from './dokploy.client'

/** Один клиент Dokploy на процесс: цепи размыкателей общие для всех модулей (назначения, сага) */
@Global()
@Module({
  providers: [{ provide: DokployClient, useFactory: () => new DokployClient(DEFAULT_DOKPLOY_CLIENT) }],
  exports: [DokployClient],
})
export class DokployModule {}
