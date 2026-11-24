import { createHash } from 'node:crypto'

/**
 * Каталог роботов. Источник — манифесты в репозитории `bots` (bots/schema/template.schema.json).
 * В базе каждая версия шаблона неизменна; развёртывание ссылается на конкретную версию.
 */
export interface TemplateManifest {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly upstream: { readonly gitUrl: string; readonly ref: string; readonly license: string }
  readonly build: { readonly type: 'dockerfile'; readonly dockerfile: string; readonly context: string }
  readonly config: {
    readonly delivery: 'env' | 'file'
    readonly schema: Record<string, unknown>
    readonly env?: Record<string, string>
    readonly mountPath?: string
    readonly template?: string
  }
  readonly metrics?: { readonly port: number; readonly path: string }
  readonly notes?: readonly string[]
}

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

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
  }

  return JSON.stringify(value)
}

/** Хранилище каталога */
export interface CatalogRepository {
  /** Вставить версию, если её нет; `true` — вставлена этим вызовом */
  insertVersion(templateId: string, version: string, source: TemplateSource): Promise<boolean>
  /** Сделать версию текущей и снять отметку «выведен» */
  setCurrent(templateId: string, version: string): Promise<void>
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

export const CATALOG_SOURCE = Symbol('CATALOG_SOURCE')
