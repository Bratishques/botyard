/** Каталог роботов: только чтение — шаблоны приходят из `bots/` через `bun run catalog:sync` в api */
import type { TemplateView } from '@botyard/contract'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { templateQuery, templatesQuery } from '../api/queries'
import { optionLabel, parseSchema, type SchemaNode } from '../schema-form/schema'
import { Badge, ErrorBox, Fact, Facts, Loading, PageHeader, Table, Td } from '../ui/kit'

export function TemplatesPage() {
  const list = useQuery(templatesQuery)
  return (
    <div>
      <PageHeader title="Каталог роботов" />
      <ErrorBox error={list.error} />
      {list.isPending ? (
        <Loading />
      ) : (
        <Table head={['Робот', 'Описание', 'Конфиг', 'Версия', 'Исходники']}>
          {list.data?.map((t) => (
            <tr key={t.id}>
              <Td className="font-medium">
                <Link to="/templates/$templateId" params={{ templateId: t.id }} className="text-sky-700 hover:underline">
                  {t.name}
                </Link>
                <div className="font-mono text-xs text-slate-500">{t.id}</div>
              </Td>
              <Td className="max-w-md text-slate-600">{t.description}</Td>
              <Td>{t.delivery === 'env' ? 'переменные окружения' : 'файл'}</Td>
              <Td className="font-mono text-xs">{t.currentVersion.slice(0, 12)}</Td>
              <Td>
                <Upstream template={t} />
              </Td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  )
}

function Upstream({ template: t }: { template: TemplateView }) {
  // gitUrl из манифеста каталога, а не из ввода пользователя; всё равно открываем только https
  const safe = t.upstream.gitUrl.startsWith('https://')
  return (
    <div className="text-xs">
      {safe ? (
        <a href={t.upstream.gitUrl} target="_blank" rel="noreferrer noopener" className="text-sky-700 hover:underline">
          {t.upstream.gitUrl.replace(/^https:\/\//, '')}
        </a>
      ) : (
        t.upstream.gitUrl
      )}
      <div className="text-slate-500">
        {t.upstream.ref} · {t.upstream.license}
      </div>
    </div>
  )
}

export function TemplatePage({ id }: { id: string }) {
  const template = useQuery(templateQuery(id))
  if (template.error) return <ErrorBox error={template.error} />
  if (!template.data) return <Loading />
  const t = template.data
  return (
    <div className="space-y-6">
      <PageHeader title={t.name}>{t.retired && <Badge value="RETIRED" />}</PageHeader>
      <section className="rounded border border-slate-200 bg-white p-4">
        <Facts>
          <Fact label="id">
            <span className="font-mono">{t.id}</span>
          </Fact>
          <Fact label="Описание">{t.description ?? '—'}</Fact>
          <Fact label="Версия">
            <span className="font-mono text-xs">{t.currentVersion}</span>
          </Fact>
          <Fact label="Доставка конфига">{t.delivery === 'env' ? 'переменные окружения' : 'файл'}</Fact>
          <Fact label="Исходники">
            <Upstream template={t} />
          </Fact>
          <Fact label="Выведен из каталога">{t.retired ? 'да — новые развёртывания недоступны' : 'нет'}</Fact>
        </Facts>
      </section>
      <section>
        <h2 className="mb-2 font-semibold">Поля конфига</h2>
        <FieldsTable node={parseSchema(t.configSchema)} />
      </section>
      <section>
        <h2 className="mb-2 font-semibold">JSON Schema конфига</h2>
        <pre className="overflow-x-auto rounded border border-slate-200 bg-white p-3 text-xs">
          {JSON.stringify(t.configSchema, null, 2)}
        </pre>
      </section>
    </div>
  )
}

interface Row {
  path: string
  node: SchemaNode
  required: boolean
}

/** Плоский список полей схемы: путь, тип, обязательность, default — чтобы не читать JSON Schema глазами */
function flatten(node: SchemaNode, path: string, required: boolean, out: Row[]): Row[] {
  if (path) out.push({ path, node, required })
  if (node.kind === 'object') for (const p of node.properties) flatten(p.node, path ? `${path}.${p.name}` : p.name, p.required, out)
  if (node.kind === 'array') flatten(node.items, `${path}[]`, true, out)
  return out
}

function typeLabel(node: SchemaNode): string {
  if (node.kind === 'enum') return node.options.map(optionLabel).join(' | ')
  if (node.kind === 'unsupported') return 'составной (JSON)'
  return node.kind
}

function FieldsTable({ node }: { node: SchemaNode }) {
  const rows = flatten(node, '', true, [])
  return (
    <Table head={['Поле', 'Тип', 'Обязательное', 'По умолчанию', 'Описание']}>
      {rows.map((r) => (
        <tr key={r.path}>
          <Td className="font-mono text-xs">{r.path}</Td>
          <Td className="text-xs">{typeLabel(r.node)}</Td>
          <Td>{r.required ? 'да' : ''}</Td>
          <Td className="font-mono text-xs">{r.node.default === undefined ? '' : JSON.stringify(r.node.default)}</Td>
          <Td className="text-xs text-slate-600">{r.node.description}</Td>
        </tr>
      ))}
    </Table>
  )
}
