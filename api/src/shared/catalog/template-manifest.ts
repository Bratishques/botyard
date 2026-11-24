/**
 * Манифест робота (bots/schema/template.schema.json). Общий контракт: его хранит база (`bot_template_version`)
 * и читает модуль каталога, поэтому тип лежит в shared, а не в модуле.
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
  /** `verifiesTls: false` — робот не проверяет сертификат T-Invest: только песочница */
  readonly security: { readonly verifiesTls: boolean }
  readonly metrics?: { readonly port: number; readonly path: string }
  readonly notes?: readonly string[]
}
