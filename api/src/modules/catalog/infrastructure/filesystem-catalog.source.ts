import { lstat, readdir, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020'
import { configSchemaValidator } from '../../../shared/catalog/config-validator'
import { ROBOT_CA_ENV, ROBOT_CA_MOUNT_PATH } from '../../../shared/tinvest/tinvest'
import { CatalogError, CatalogErrorCode, type CatalogSource, type TemplateManifest, type TemplateSource } from '../domain/catalog'
import { checkTemplate } from './template-variables'

/** Манифест как он лежит в репозитории: со служебной ссылкой на схему */
type ManifestFile = TemplateManifest & { $schema?: string }

/** Переменные окружения, которые выставляет платформа (корень сертификатов T-Invest) */
const RESERVED_ENV = new Set([...Object.keys(ROBOT_CA_ENV), 'SSL_CERT_DIR'])

/** Имя файла шаблона внутри папки шаблона: только такое, без путей и скрытых файлов */
const TEMPLATE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/

/**
 * Каталог роботов на диске: `<dir>/templates/<id>/template.json` и файлы, на которые манифест ссылается.
 *
 * Репозиторий `bots` публичный, поэтому его содержимое — недоверенный ввод:
 * - симлинки (папка шаблона, манифест, файл шаблона) отклоняются, а реальный путь сверяется с папкой
 *   шаблона — иначе `config.toml.tpl -> /proc/self/environ` унёс бы окружение процесса в базу;
 * - манифест проверяется схемой каталога в строгом режиме ajv, его `config.schema` компилируется тоже
 *   строго — опечатка в ключевом слове схемы (`requird`) не проходит молча;
 * - любая ошибка чтения или разбора — `CATALOG_INVALID_MANIFEST` с именем шаблона и причиной.
 */
export class FilesystemCatalogSource implements CatalogSource {
  constructor(private readonly dir: string) {}

  async read(): Promise<TemplateSource[]> {
    const { validateManifest, templatesDir, folders } = await this.openCatalog()

    const sources: TemplateSource[] = []
    for (const folder of folders) {
      if (folder.startsWith('.')) continue
      try {
        sources.push(await this.readTemplate(templatesDir, folder, validateManifest))
      } catch (error) {
        if (error instanceof CatalogError) throw error
        throw invalid(folder, error instanceof Error ? error.message : String(error))
      }
    }

    return sources
  }

  /** Схема каталога и папка шаблонов: ошибки уровня всего каталога — тоже `CATALOG_INVALID_MANIFEST` */
  private async openCatalog(): Promise<{ validateManifest: ValidateFunction<ManifestFile>; templatesDir: string; folders: string[] }> {
    const catalogError = (reason: string) => new CatalogError(CatalogErrorCode.INVALID_MANIFEST, `catalog ${this.dir}: ${reason}`)
    try {
      const schemaPath = path.join(this.dir, 'schema', 'template.schema.json')
      const templatesPath = path.join(this.dir, 'templates')
      await assertPlain(path.join(this.dir, 'schema'), 'directory', catalogError)
      await assertPlain(schemaPath, 'file', catalogError)
      await assertPlain(templatesPath, 'directory', catalogError)

      const manifestAjv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false })
      const validateManifest = manifestAjv.compile<ManifestFile>(JSON.parse(await readFile(schemaPath, 'utf8')))
      const folders = (await readdir(templatesPath, { withFileTypes: true })).map((entry) => entry.name).sort()

      return { validateManifest, templatesDir: await realpath(templatesPath), folders }
    } catch (error) {
      if (error instanceof CatalogError) throw error
      throw new CatalogError(
        CatalogErrorCode.INVALID_MANIFEST,
        `catalog ${this.dir}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  private async readTemplate(
    templatesDir: string,
    folder: string,
    validateManifest: ValidateFunction<ManifestFile>,
  ): Promise<TemplateSource> {
    const folderPath = path.join(templatesDir, folder)
    await assertPlain(folderPath, 'directory', (reason) => invalid(folder, reason))

    const manifestPath = path.join(folderPath, 'template.json')
    await assertPlain(manifestPath, 'file', (reason) => invalid(folder, reason))
    const raw: unknown = JSON.parse(await readFile(manifestPath, 'utf8'))
    if (!validateManifest(raw))
      throw invalid(folder, validateManifest.errors?.map((error) => `${error.instancePath} ${error.message}`).join('; ') ?? 'invalid')
    if (raw.id !== folder) throw invalid(folder, `id "${raw.id}" does not match the folder name`)

    try {
      // Свой экземпляр на шаблон: одинаковый `$id` в схемах двух шаблонов не должен конфликтовать
      configSchemaValidator().compile(raw.config.schema)
    } catch (error) {
      throw invalid(folder, `config.schema is not a valid JSON Schema: ${error instanceof Error ? error.message : String(error)}`)
    }

    const files: Record<string, string> = {}
    if (raw.config.template !== undefined) {
      const name = raw.config.template
      if (!TEMPLATE_FILE.test(name) || name === 'template.json') {
        throw invalid(folder, 'config.template must be a plain file name inside the template folder, other than template.json')
      }
      const filePath = path.join(folderPath, name)
      await assertPlain(filePath, 'file', (reason) => invalid(folder, reason))
      if (path.dirname(await realpath(filePath)) !== (await realpath(folderPath))) {
        throw invalid(folder, 'config.template must stay inside the template folder')
      }
      files[name] = await readFile(filePath, 'utf8')
    }

    // Шаблоны конфига: компилируются, переменные — только допустимые (template-variables.ts)
    const templates: [string, string][] = [
      ...Object.entries(raw.config.env ?? {}).map(([variable, value]): [string, string] => [`env ${variable}`, value]),
      ...Object.entries(files).map(([name, content]): [string, string] => [name, content]),
    ]
    for (const [where, source] of templates) {
      const problems = checkTemplate(source, raw.config.schema)
      if (problems.length > 0) throw invalid(folder, `${where}: ${problems.join('; ')}`)
    }

    // Имена, которые платформа даёт роботу сама: шаблон не может их подменить
    const reserved = Object.keys(raw.config.env ?? {}).filter((name) => RESERVED_ENV.has(name))
    if (reserved.length > 0) throw invalid(folder, `config.env: ${reserved.join(', ')} is set by the platform`)
    if (raw.config.mountPath !== undefined && path.posix.dirname(raw.config.mountPath) === path.posix.dirname(ROBOT_CA_MOUNT_PATH)) {
      throw invalid(folder, `config.mountPath: ${path.posix.dirname(ROBOT_CA_MOUNT_PATH)} is used by the platform`)
    }

    // Манифест хранится без служебного `$schema`: это ссылка на файл в репозитории, не часть шаблона
    const { $schema: _schema, ...manifest } = raw
    return { manifest, files }
  }
}

/** Обычный файл или папка, не симлинк: симлинк из публичного репозитория может вести куда угодно */
async function assertPlain(target: string, kind: 'file' | 'directory', fail: (reason: string) => CatalogError): Promise<void> {
  const stats = await lstat(target).catch(() => null)
  if (!stats) throw fail(`${path.basename(target)} is missing`)
  if (stats.isSymbolicLink()) throw fail(`${path.basename(target)} must not be a symlink`)
  if (kind === 'file' ? !stats.isFile() : !stats.isDirectory()) throw fail(`${path.basename(target)} must be a ${kind}`)
}

function invalid(folder: string, reason: string): CatalogError {
  return new CatalogError(CatalogErrorCode.INVALID_MANIFEST, `template ${folder}: ${reason}`)
}
