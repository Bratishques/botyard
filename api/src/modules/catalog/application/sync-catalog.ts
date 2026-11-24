import type { AuditLog } from '../../../shared/audit/audit'
import type { UnitOfWork } from '../../../shared/database/unit-of-work'
import { type CatalogRepository, type CatalogSource, templateVersion } from '../domain/catalog'

export interface SyncReport {
  readonly added: { templateId: string; version: string }[]
  readonly unchanged: string[]
  readonly retired: string[]
}

/**
 * Синхронизация каталога с репозиторием `bots`. Чтение и проверка манифестов — до транзакции; запись
 * всех шаблонов, отметка выведенных и аудит — одна транзакция: каталог не остаётся наполовину обновлённым.
 *
 * Повторный запуск без изменений ничего не пишет. Две синхронизации одновременно безопасны: версия
 * вставляется `ON CONFLICT DO NOTHING`, а текущая версия — последняя записавшая, обе одинаковы.
 */
export class SyncCatalog {
  constructor(
    private readonly source: CatalogSource,
    private readonly repository: CatalogRepository,
    private readonly unitOfWork: UnitOfWork,
    private readonly audit: AuditLog,
  ) {}

  async execute(actor: string): Promise<SyncReport> {
    const sources = await this.source.read()
    const versions = sources.map((source) => ({ source, templateId: source.manifest.id, version: templateVersion(source) }))

    return this.unitOfWork.run(async () => {
      const report: SyncReport = { added: [], unchanged: [], retired: [] }
      for (const { source, templateId, version } of versions) {
        // Сначала шаблон: ссылка шаблона на текущую версию отложена до коммита, ссылка версии на шаблон — нет
        await this.repository.setCurrent(templateId, version)
        const inserted = await this.repository.insertVersion(templateId, version, source)
        if (inserted) report.added.push({ templateId, version })
        else report.unchanged.push(templateId)
      }
      report.retired.push(...(await this.repository.retireMissing(versions.map((item) => item.templateId))))

      if (report.added.length > 0 || report.retired.length > 0) {
        await this.audit.record({
          actor,
          action: 'catalog.synced',
          targetType: 'catalog',
          targetId: null,
          payload: { added: report.added, retired: report.retired },
        })
      }

      return report
    })
  }
}
