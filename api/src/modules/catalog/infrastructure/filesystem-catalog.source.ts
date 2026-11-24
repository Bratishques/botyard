import { lstat, readdir, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020'
import { CatalogError, CatalogErrorCode, type CatalogSource, type TemplateManifest, type TemplateSource } from '../domain/catalog'

/** Манифест как он лежит в репозитории: со служебной ссылкой на схему */
type ManifestFile = TemplateManifest & { $schema?: string }

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
    const manifestAjv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false })
    const configAjv = new Ajv2020({ strict: true })
    const validateManifest = manifestAjv.compile<ManifestFile>(
      JSON.parse(await readFile(path.join(this.dir, 'schema', 'template.schema.json'), 'utf8')),
    )

    const templatesDir = await realpath(path.join(this.dir, 'templates'))
    const folders = (await readdir(templatesDir, { withFileTypes: true })).map((entry) => entry.name).sort()

    const sources: TemplateSource[] = []
    for (const folder of folders) {
      if (folder.startsWith('.')) continue
      try {
        sources.push(await this.readTemplate(templatesDir, folder, validateManifest, configAjv))
      } catch (error) {
        if (error instanceof CatalogError) throw error
        throw invalid(folder, error instanceof Error ? error.message : String(error))
      }
    }

    return sources
  }

  private async readTemplate(
    templatesDir: string,
    folder: string,
    validateManifest: ValidateFunction<ManifestFile>,
    configAjv: Ajv2020,
  ): Promise<TemplateSource> {
    const folderPath = path.join(templatesDir, folder)
    await assertPlain(folderPath, 'directory', folder)

    const manifestPath = path.join(folderPath, 'template.json')
    await assertPlain(manifestPath, 'file', folder)
    const raw: unknown = JSON.parse(await readFile(manifestPath, 'utf8'))
    if (!validateManifest(raw))
      throw invalid(folder, validateManifest.errors?.map((error) => `${error.instancePath} ${error.message}`).join('; ') ?? 'invalid')
    if (raw.id !== folder) throw invalid(folder, `id "${raw.id}" does not match the folder name`)

    try {
      configAjv.compile(raw.config.schema)
    } catch (error) {
      throw invalid(folder, `config.schema is not a valid JSON Schema: ${error instanceof Error ? error.message : String(error)}`)
    }

    const files: Record<string, string> = {}
    if (raw.config.template !== undefined) {
      const name = raw.config.template
      if (!TEMPLATE_FILE.test(name)) throw invalid(folder, 'config.template must be a plain file name inside the template folder')
      const filePath = path.join(folderPath, name)
      await assertPlain(filePath, 'file', folder)
      if (path.dirname(await realpath(filePath)) !== (await realpath(folderPath))) {
        throw invalid(folder, 'config.template must stay inside the template folder')
      }
      files[name] = await readFile(filePath, 'utf8')
    }

    // Манифест хранится без служебного `$schema`: это ссылка на файл в репозитории, не часть шаблона
    const { $schema: _schema, ...manifest } = raw
    return { manifest, files }
  }
}

/** Обычный файл или папка, не симлинк: симлинк из публичного репозитория может вести куда угодно */
async function assertPlain(target: string, kind: 'file' | 'directory', folder: string): Promise<void> {
  const stats = await lstat(target).catch(() => null)
  if (!stats) throw invalid(folder, `${path.basename(target)} is missing`)
  if (stats.isSymbolicLink()) throw invalid(folder, `${path.basename(target)} must not be a symlink`)
  if (kind === 'file' ? !stats.isFile() : !stats.isDirectory()) throw invalid(folder, `${path.basename(target)} must be a ${kind}`)
}

function invalid(folder: string, reason: string): CatalogError {
  return new CatalogError(CatalogErrorCode.INVALID_MANIFEST, `template ${folder}: ${reason}`)
}
