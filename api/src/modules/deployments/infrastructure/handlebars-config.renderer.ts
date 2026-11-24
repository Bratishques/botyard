import { Injectable } from '@nestjs/common'
import Handlebars from 'handlebars'
import { ROBOT_CA_ENV, ROBOT_CA_MOUNT_PATH, TINVEST_ROOT_CA_PEM } from '../../../shared/tinvest/tinvest'
import {
  type ConfigRenderer,
  RenderError,
  RenderErrorCode,
  type RenderInput,
  type RobotFile,
  type RobotRuntime,
} from '../domain/robot-runtime'

/**
 * Значение переменной окружения: без пробелов, кавычек, `#`, `$`, `\` и переводов строки. Dokploy хранит env
 * строками `KEY=value` и разбирает их как dotenv: перевод строки дописал бы переменную, `#` обрезал бы
 * значение, `$` — подстановка. Экранирование у dotenv своё в каждой версии, поэтому не экранируем, а
 * пропускаем только безопасное: FIGI, счёт, токен, перечисления, числа и булевы под это подходят.
 */
const SAFE_ENV_VALUE = /^[A-Za-z0-9_.,:/+=@-]*$/

/**
 * Рендер конфига робота из шаблона версии. Шаблоны уже проверены при синхронизации каталога
 * (template-variables.ts): здесь — подстановка значений с экранированием под формат назначения.
 *
 * - `noEscape`: HTML-экранирование Handlebars для env и TOML неверно (`=` стало бы `&#x3D;`);
 * - `strict`: обращение к отсутствующему полю — ошибка, а не пустая строка;
 * - env: значения — по белому списку символов (SAFE_ENV_VALUE);
 * - TOML: строки в контексте экранируются как базовые строки TOML, результат разбирается `Bun.TOML.parse`;
 * - каждому роботу платформа добавляет корень сертификатов T-Invest файлом и `SSL_CERT_FILE`.
 */
@Injectable()
export class HandlebarsConfigRenderer implements ConfigRenderer {
  private readonly handlebars = createHandlebars()

  render(input: RenderInput): RobotRuntime {
    const context = {
      config: input.config,
      customer: { accountId: input.customer.accountId, sandbox: input.customer.sandbox },
      secret: { tinvestToken: input.token },
      platform: { tinvestAddress: input.tinvestAddress },
    }

    const env: Record<string, string> = {}
    for (const [name, source] of Object.entries(input.manifest.config.env ?? {})) {
      const value = this.apply(source, context, `env ${name}`)
      if (!SAFE_ENV_VALUE.test(value)) {
        throw new RenderError(RenderErrorCode.UNSAFE_VALUE, `env ${name}: value has characters not allowed in an environment variable`)
      }
      env[name] = value
    }
    Object.assign(env, ROBOT_CA_ENV)

    const files: RobotFile[] = [{ mountPath: ROBOT_CA_MOUNT_PATH, content: TINVEST_ROOT_CA_PEM }]
    if (input.manifest.config.delivery === 'file') files.push(this.renderFile(input, context))

    return { env, files }
  }

  private renderFile(input: RenderInput, context: Record<string, unknown>): RobotFile {
    const { mountPath, template } = input.manifest.config
    const source = template === undefined ? undefined : input.files[template]
    if (mountPath === undefined || source === undefined) {
      throw new RenderError(RenderErrorCode.TEMPLATE_FAILED, 'file delivery needs mountPath and the template file')
    }
    if (!mountPath.endsWith('.toml')) {
      throw new RenderError(RenderErrorCode.TEMPLATE_FAILED, `${mountPath}: only TOML files are supported`)
    }

    const content = this.apply(source, escapeStrings(context, tomlString), template ?? mountPath)
    try {
      Bun.TOML.parse(content)
    } catch {
      // Текст ошибки разбора цитирует строку файла, а в файле — токен: наружу только факт
      throw new RenderError(RenderErrorCode.INVALID_OUTPUT, `${mountPath}: rendered file is not valid TOML`)
    }

    return { mountPath, content }
  }

  private apply(source: string, context: unknown, where: string): string {
    try {
      return this.handlebars.compile(source, { strict: true, noEscape: true })(context)
    } catch (error) {
      // Сообщение strict-режима — имя поля, без значений
      const reason = error instanceof Error ? (error.message.split('\n')[0] ?? 'failed') : 'failed'
      throw new RenderError(RenderErrorCode.TEMPLATE_FAILED, `${where}: ${reason}`)
    }
  }
}

/** Отдельное окружение Handlebars: хелпер `join` не попадает в глобальное и не виден чужому коду */
function createHandlebars(): typeof Handlebars {
  const instance = Handlebars.create()
  instance.registerHelper('join', (list: unknown, separator: unknown) => {
    if (!Array.isArray(list) || typeof separator !== 'string') throw new Error('join takes an array and a separator')
    return list.map(String).join(separator)
  })

  return instance
}

/** Копия контекста, где каждая строка экранирована; числа и булевы остаются собой */
function escapeStrings(value: unknown, escapeText: (text: string) => string): unknown {
  if (typeof value === 'string') return escapeText(value)
  if (Array.isArray(value)) return value.map((item) => escapeStrings(item, escapeText))
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, escapeStrings(item, escapeText)]))
  }

  return value
}

/** Содержимое базовой строки TOML (между кавычками): `\`, `"` и управляющие символы — escape-последовательности */
export function tomlString(text: string): string {
  let result = ''
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (char === '\\') result += '\\\\'
    else if (char === '"') result += '\\"'
    else if (code < 0x20 || code === 0x7f) result += `\\u${code.toString(16).padStart(4, '0')}`
    else result += char
  }

  return result
}
