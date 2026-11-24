import { createHash } from 'node:crypto'
import type { TemplateManifest } from '../../../shared/catalog/template-manifest'
import { canonicalJson } from '../../../shared/json/canonical-json'

/**
 * Каталог роботов. Источник — манифесты в репозитории `bots` (bots/schema/template.schema.json).
 * В базе каждая версия шаблона неизменна; развёртывание ссылается на конкретную версию.
 */
export type { TemplateManifest } from '../../../shared/catalog/template-manifest'

/** Шаблон, прочитанный из каталога: манифест и файлы, на которые он ссылается (шаблон конфига) */
export interface TemplateSource {
  readonly manifest: TemplateManifest
  readonly files: Readonly<Record<string, string>>
}

export interface TemplateVersion extends TemplateSource {
  readonly templateId: string
  readonly version: string
  readonly loadedAt: Date
}

export interface CatalogTemplate {
  readonly id: string
  readonly name: string
  readonly description: string | null
  readonly currentVersion: string
  readonly retired: boolean
  readonly delivery: 'env' | 'file'
  readonly configSchema: Record<string, unknown>
  readonly upstream: TemplateManifest['upstream']
}

export const CatalogErrorCode = {
  INVALID_MANIFEST: 'CATALOG_INVALID_MANIFEST',
  TEMPLATE_NOT_FOUND: 'CATALOG_TEMPLATE_NOT_FOUND',
} as const
export type CatalogErrorCode = (typeof CatalogErrorCode)[keyof typeof CatalogErrorCode]

export class CatalogError extends Error {
  override readonly name = 'CatalogError'

  constructor(
    readonly code: CatalogErrorCode,
    message: string,
  ) {
    super(message)
  }
}

/**
 * Версия шаблона — SHA-256 канонического JSON манифеста и файлов. Канонический — ключи отсортированы:
 * перестановка полей в манифесте новую версию не создаёт, правка значения — создаёт.
 */
export function templateVersion(source: TemplateSource): string {
  return createHash('sha256')
    .update(canonicalJson({ manifest: source.manifest, files: source.files }))
    .digest('hex')
}

/** Хранилище каталога */
export interface CatalogRepository {
  /** Вставить версию, если её нет; `true` — вставлена этим вызовом */
  insertVersion(templateId: string, version: string, source: TemplateSource): Promise<boolean>
  /** Синхронизации каталога идут по одной: блокировка до конца транзакции */
  lockForSync(): Promise<void>
  /**
   * Сделать версию текущей и снять отметку «выведен». Пишет, только если что-то меняется; возвращает
   * прежнее состояние (`null` — шаблона не было), чтобы отчёт и аудит видели переключение
   */
  setCurrent(templateId: string, version: string): Promise<{ previousVersion: string | null; wasRetired: boolean } | 'unchanged'>
  /** Пометить выведенными все шаблоны, которых нет в списке; вернуть их id */
  retireMissing(presentIds: readonly string[]): Promise<string[]>
  list(): Promise<CatalogTemplate[]>
  findVersion(templateId: string, version: string): Promise<TemplateVersion | null>
}

export const CATALOG_REPOSITORY = Symbol('CATALOG_REPOSITORY')

/** Источник манифестов (каталог `bots` на диске) */
export interface CatalogSource {
  read(): Promise<TemplateSource[]>
}

export { canonicalJson }
