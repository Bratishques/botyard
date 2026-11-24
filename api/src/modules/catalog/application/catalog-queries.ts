import { Inject, Injectable } from '@nestjs/common'
import { CATALOG_REPOSITORY, CatalogError, CatalogErrorCode, type CatalogRepository, type CatalogTemplate } from '../domain/catalog'

/**
 * Чтение каталога для админки. Список — только действующие шаблоны (из них создают развёртывания);
 * карточка — любой, в том числе выведенный: на него ссылаются уже развёрнутые роботы.
 */
@Injectable()
export class CatalogQueries {
  constructor(@Inject(CATALOG_REPOSITORY) private readonly catalog: CatalogRepository) {}

  async active(): Promise<CatalogTemplate[]> {
    return (await this.catalog.list()).filter((template) => !template.retired)
  }

  async get(id: string): Promise<CatalogTemplate> {
    const template = (await this.catalog.list()).find((item) => item.id === id)
    if (!template) throw new CatalogError(CatalogErrorCode.TEMPLATE_NOT_FOUND, `template ${id} is not found`)

    return template
  }
}
