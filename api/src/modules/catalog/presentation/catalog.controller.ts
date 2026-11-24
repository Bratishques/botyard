import { Controller, Get, Inject, NotFoundException, Param } from '@nestjs/common'
import { CATALOG_REPOSITORY, type CatalogRepository, type CatalogTemplate } from '../domain/catalog'

/** Каталог роботов для админки: что можно развернуть и какой конфиг каждый ждёт (JSON Schema) */
@Controller('templates')
export class CatalogController {
  constructor(@Inject(CATALOG_REPOSITORY) private readonly catalog: CatalogRepository) {}

  @Get()
  async list(): Promise<CatalogTemplate[]> {
    return (await this.catalog.list()).filter((template) => !template.retired)
  }

  @Get(':id')
  async get(@Param('id') id: string): Promise<CatalogTemplate> {
    const template = (await this.catalog.list()).find((item) => item.id === id)
    if (!template) throw new NotFoundException({ code: 'CATALOG_TEMPLATE_NOT_FOUND', message: `template ${id} is not found` })

    return template
  }
}
