/** Шаблон робота из каталога: что можно развернуть и какой конфиг он ждёт (JSON Schema для формы) */
export interface TemplateView {
  id: string
  name: string
  description: string | null
  currentVersion: string
  retired: boolean
  delivery: 'env' | 'file'
  configSchema: Record<string, unknown>
  upstream: { gitUrl: string; ref: string; license: string }
}
