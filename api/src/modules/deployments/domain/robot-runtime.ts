import type { TemplateManifest } from '../../../shared/catalog/template-manifest'

/**
 * Что получает робот в Dokploy: переменные окружения и файлы. Секрет (токен T-Invest) здесь уже открытым
 * текстом — объект живёт только на время шага саги, не логируется и не сохраняется.
 */
export interface RobotRuntime {
  readonly env: Readonly<Record<string, string>>
  readonly files: readonly RobotFile[]
}

export interface RobotFile {
  readonly mountPath: string
  readonly content: string
}

export interface RenderInput {
  readonly manifest: TemplateManifest
  readonly files: Readonly<Record<string, string>>
  readonly config: Readonly<Record<string, unknown>>
  readonly customer: { readonly accountId: string; readonly sandbox: boolean }
  readonly token: string
  readonly tinvestAddress: string
}

export const RenderErrorCode = {
  /** Значение не помещается в формат без риска (перевод строки в env и т. п.) */
  UNSAFE_VALUE: 'RENDER_UNSAFE_VALUE',
  /** Результат не разбирается как формат файла */
  INVALID_OUTPUT: 'RENDER_INVALID_OUTPUT',
  /** Шаблон обратился к отсутствующему полю или формат файла не поддерживается */
  TEMPLATE_FAILED: 'RENDER_TEMPLATE_FAILED',
} as const
export type RenderErrorCode = (typeof RenderErrorCode)[keyof typeof RenderErrorCode]

/** Ошибка рендера. Текст — без значений: в них бывает токен */
export class RenderError extends Error {
  override readonly name = 'RenderError'

  constructor(
    readonly code: RenderErrorCode,
    message: string,
  ) {
    super(message)
  }
}

export interface ConfigRenderer {
  render(input: RenderInput): RobotRuntime
}

export const CONFIG_RENDERER = Symbol('CONFIG_RENDERER')
