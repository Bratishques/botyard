import type { AuditLog } from '../../../shared/audit/audit'
import type { UnitOfWork } from '../../../shared/database/unit-of-work'
import { CatalogError, CatalogErrorCode, type CatalogRepository, type CatalogSource, templateVersion } from '../domain/catalog'

export interface SyncReport {
  /** Новые версии (шаблон новый или его манифест изменился) */
  readonly added: { templateId: string; version: string }[]
  /** Текущая версия сменилась на уже известную (откат манифеста) */
  readonly switched: { templateId: string; from: string; to: string }[]
  /** Выведенный шаблон вернулся в каталог */
  readonly restored: string[]
  readonly unchanged: string[]
  readonly retired: string[]
}

/**
 * Синхронизация каталога с репозиторием `bots`. Чтение и проверка манифестов — до транзакции; запись,
 * отметка выведенных и аудит — одна транзакция под блокировкой синхронизации: синхронизации идут по
 * одной, каталог не обновляется наполовину и не ловит взаимную блокировку.
 *
 * Запуск без изменений ничего не пишет. Любое изменение — новая версия, переключение текущей, возврат
 * или вывод шаблона — попадает в отчёт и в аудит. Пустой каталог — скорее неверный путь, чем намерение
 * вывести всё: он отклоняется без явного `allowEmpty`.
 */
export class SyncCatalog {
  constructor(
    private readonly source: CatalogSource,
    private readonly repository: CatalogRepository,
    private readonly unitOfWork: UnitOfWork,
    private readonly audit: AuditLog,
  ) {}

  async execute(actor: string, options: { allowEmpty?: boolean } = {}): Promise<SyncReport> {
    const sources = await this.source.read()
    if (sources.length === 0 && !options.allowEmpty) {
      throw new CatalogError(
        CatalogErrorCode.INVALID_MANIFEST,
        'catalog is empty: check the path, or pass allowEmpty to retire every template',
      )
    }
    const versions = sources.map((source) => ({ source, templateId: source.manifest.id, version: templateVersion(source) }))

    return this.unitOfWork.run(async () => {
      await this.repository.lockForSync()
      const report: SyncReport = { added: [], switched: [], restored: [], unchanged: [], retired: [] }

      for (const { source, templateId, version } of versions) {
        // Сначала шаблон: ссылка шаблона на текущую версию отложена до коммита, ссылка версии на шаблон — нет
        const change = await this.repository.setCurrent(templateId, version)
        const inserted = await this.repository.insertVersion(templateId, version, source)

        if (inserted) report.added.push({ templateId, version })
        else if (change !== 'unchanged' && change.previousVersion !== null && change.previousVersion !== version) {
          report.switched.push({ templateId, from: change.previousVersion, to: version })
        }
        if (change !== 'unchanged' && change.wasRetired) report.restored.push(templateId)
        if (change === 'unchanged') report.unchanged.push(templateId)
      }
      report.retired.push(...(await this.repository.retireMissing(versions.map((item) => item.templateId))))

      const changed = report.added.length + report.switched.length + report.restored.length + report.retired.length > 0
      if (changed) {
        await this.audit.record({
          actor,
          action: 'catalog.synced',
          targetType: 'catalog',
          targetId: null,
          payload: { added: report.added, switched: report.switched, restored: report.restored, retired: report.retired },
        })
      }

      return report
    })
  }
}
