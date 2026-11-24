import { Module } from '@nestjs/common'
import { CatalogQueries } from './application/catalog-queries'
import { CATALOG_REPOSITORY } from './domain/catalog'
import { PostgresCatalogRepository } from './infrastructure/postgres-catalog.repository'
import { CatalogController } from './presentation/catalog.controller'

@Module({
  controllers: [CatalogController],
  providers: [{ provide: CATALOG_REPOSITORY, useClass: PostgresCatalogRepository }, CatalogQueries],
  exports: [CATALOG_REPOSITORY, CatalogQueries],
})
export class CatalogModule {}
