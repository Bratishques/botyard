import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import Ajv2020 from 'ajv/dist/2020'
import { CatalogError, CatalogErrorCode, type CatalogSource, type TemplateManifest, type TemplateSource } from '../domain/catalog'

/**
 * Каталог роботов на диске: `<dir>/templates/<id>/template.json` и файлы, на которые манифест ссылается.
 *
 * Каждый манифест проверяется схемой каталога (`<dir>/schema/template.schema.json`), а его
 * `config.schema` компилируется как JSON Schema: битая схема конфига не должна попасть в каталог и
 * всплыть только при первом развёртывании. Id в манифесте обязан совпадать с именем папки.
 */
export class FilesystemCatalogSource implements CatalogSource {
  constructor(private readonly dir: string) {}

  async read(): Promise<TemplateSource[]> {
    const ajv = new Ajv2020({ allErrors: true, strict: false })
    const validateManifest = ajv.compile(JSON.parse(await readFile(path.join(this.dir, 'schema', 'template.schema.json'), 'utf8')))

    const templatesDir = path.join(this.dir, 'templates')
    const entries = (await readdir(templatesDir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name)

    const sources: TemplateSource[] = []
    for (const folder of entries.sort()) {
      const raw: unknown = JSON.parse(await readFile(path.join(templatesDir, folder, 'template.json'), 'utf8'))
      if (!validateManifest(raw)) {
        throw invalid(folder, ajv.errorsText(validateManifest.errors))
      }
      const manifest = raw as TemplateManifest
      if (manifest.id !== folder) throw invalid(folder, `id "${manifest.id}" does not match the folder name`)

      try {
        new Ajv2020({ strict: false }).compile(manifest.config.schema)
      } catch (error) {
        throw invalid(folder, `config.schema is not a valid JSON Schema: ${error instanceof Error ? error.message : String(error)}`)
      }

      const files: Record<string, string> = {}
      if (manifest.config.template) {
        const name = manifest.config.template
        if (name.includes('/') || name.includes('..'))
          throw invalid(folder, 'config.template must be a file name inside the template folder')
        files[name] = await readFile(path.join(templatesDir, folder, name), 'utf8')
      }

      // Манифест хранится без служебного `$schema`: это ссылка на файл в репозитории, не часть шаблона
      const { $schema: _schema, ...clean } = manifest as TemplateManifest & { $schema?: string }
      sources.push({ manifest: clean, files })
    }

    return sources
  }
}

function invalid(folder: string, reason: string): CatalogError {
  return new CatalogError(CatalogErrorCode.INVALID_MANIFEST, `template ${folder}: ${reason}`)
}
