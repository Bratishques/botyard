import type { TemplateView } from '@botyard/contract'
import { Controller, Get, NotFoundException, Param } from '@nestjs/common'
import { CatalogQueries } from '../application/catalog-queries'
import { CatalogError } from '../domain/catalog'

/** Каталог роботов для админки: что можно развернуть и какой конфиг каждый ждёт (JSON Schema) */
@Controller('templates')
export class CatalogController {
  constructor(private readonly catalog: CatalogQueries) {}

  @Get()
  list(): Promise<TemplateView[]> {
    return this.catalog.active()
  }

  @Get(':id')
  async get(@Param('id') id: string): Promise<TemplateView> {
    try {
      return await this.catalog.get(id)
    } catch (error) {
      if (error instanceof CatalogError) throw new NotFoundException({ code: error.code, message: error.message })
      throw error
    }
  }
}
