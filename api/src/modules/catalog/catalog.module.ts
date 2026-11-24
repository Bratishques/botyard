import { Module } from '@nestjs/common'
import { CATALOG_REPOSITORY } from './domain/catalog'
import { PostgresCatalogRepository } from './infrastructure/postgres-catalog.repository'
import { CatalogController } from './presentation/catalog.controller'

@Module({
  controllers: [CatalogController],
  providers: [{ provide: CATALOG_REPOSITORY, useClass: PostgresCatalogRepository }],
  exports: [CATALOG_REPOSITORY],
})
export class CatalogModule {}
