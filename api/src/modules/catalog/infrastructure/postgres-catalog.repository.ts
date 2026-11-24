import { Injectable } from '@nestjs/common'
import { sql } from 'kysely'
import { UnitOfWork } from '../../../shared/database/unit-of-work'
import type { CatalogRepository, CatalogTemplate, TemplateManifest, TemplateSource, TemplateVersion } from '../domain/catalog'

@Injectable()
export class PostgresCatalogRepository implements CatalogRepository {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  async insertVersion(templateId: string, version: string, source: TemplateSource): Promise<boolean> {
    const inserted = await this.unitOfWork
      .db()
      .insertInto('bot_template_version')
      .values({
        template_id: templateId,
        version,
        name: source.manifest.name,
        manifest: JSON.stringify(source.manifest),
        files: JSON.stringify(source.files),
      })
      .onConflict((conflict) => conflict.columns(['template_id', 'version']).doNothing())
      .returning('version')
      .executeTakeFirst()

    return inserted !== undefined
  }

  async setCurrent(templateId: string, version: string): Promise<void> {
    await this.unitOfWork
      .db()
      .insertInto('bot_template')
      .values({ id: templateId, current_version: version })
      .onConflict((conflict) =>
        conflict.column('id').doUpdateSet({ current_version: version, retired: false, updated_at: sql<Date>`now()` }),
      )
      .execute()
  }

  async retireMissing(presentIds: readonly string[]): Promise<string[]> {
    const rows = await this.unitOfWork
      .db()
      .updateTable('bot_template')
      .set({ retired: true, updated_at: new Date() })
      .where('retired', '=', false)
      .$if(presentIds.length > 0, (query) => query.where('id', 'not in', presentIds))
      .returning('id')
      .execute()

    return rows.map((row) => row.id)
  }

  async list(): Promise<CatalogTemplate[]> {
    const rows = await this.unitOfWork
      .db()
      .selectFrom('bot_template')
      .innerJoin('bot_template_version', (join) =>
        join
          .onRef('bot_template_version.template_id', '=', 'bot_template.id')
          .onRef('bot_template_version.version', '=', 'bot_template.current_version'),
      )
      .select(['bot_template.id', 'bot_template.current_version', 'bot_template.retired', 'bot_template_version.manifest'])
      .orderBy('bot_template.id')
      .execute()

    return rows.map((row) => {
      const manifest = row.manifest as unknown as TemplateManifest
      return {
        id: row.id,
        name: manifest.name,
        description: manifest.description ?? null,
        currentVersion: row.current_version,
        retired: row.retired,
        delivery: manifest.config.delivery,
        configSchema: manifest.config.schema,
        upstream: manifest.upstream,
      }
    })
  }

  async findVersion(templateId: string, version: string): Promise<TemplateVersion | null> {
    const row = await this.unitOfWork
      .db()
      .selectFrom('bot_template_version')
      .select(['template_id', 'version', 'manifest', 'files', 'loaded_at'])
      .where('template_id', '=', templateId)
      .where('version', '=', version)
      .executeTakeFirst()
    if (!row) return null

    return {
      templateId: row.template_id,
      version: row.version,
      manifest: row.manifest as unknown as TemplateManifest,
      files: row.files,
      loadedAt: row.loaded_at,
    }
  }
}
