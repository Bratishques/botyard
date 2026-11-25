/**
 * Подмножество JSON Schema для формы конфига робота: object, array (в том числе массив объектов), string,
 * enum, number, integer, boolean, `default` и `required`.
 *
 * Сервер остаётся источником истины: он проверяет конфиг по полной схеме (ajv, draft 2020-12) и подставляет
 * `default`. Форма лишь помогает оператору заполнить поля и ловит очевидное (пустое обязательное, не число).
 * Всё, что форма не понимает (`oneOf`, `$ref`, …), показывается полем JSON — значение уходит как есть,
 * и его проверит сервер.
 *
 * Значения формы отличаются от конфига:
 * - число — строка ввода: пустое поле отличимо от нуля, а «abc» — от отсутствия значения;
 * - enum — индекс варианта строкой: варианты бывают не строками;
 * - элемент массива — `{ value }`: `useFieldArray` хранит только объекты.
 * Переход туда и обратно — `toFormValue` и `toConfig`.
 */
import { z } from 'zod'

interface Common {
  title?: string
  description?: string
  default?: unknown
}

export type SchemaNode =
  | (Common & { kind: 'object'; properties: { name: string; node: SchemaNode; required: boolean }[] })
  | (Common & { kind: 'array'; items: SchemaNode; minItems?: number; maxItems?: number })
  | (Common & { kind: 'string'; minLength?: number; maxLength?: number; pattern?: string })
  | (Common & {
      kind: 'number' | 'integer'
      minimum?: number
      maximum?: number
      exclusiveMinimum?: number
      exclusiveMaximum?: number
    })
  | (Common & { kind: 'boolean' })
  | (Common & { kind: 'enum'; options: unknown[] })
  | (Common & { kind: 'unsupported' })

export type FormValue = string | boolean | FormValue[] | { value: FormValue } | { [key: string]: FormValue }

type Json = Record<string, unknown>

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)
const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

/** Тип узла: `["string", "null"]` — строка; `null` форма не задаёт, пустое поле — отсутствие значения */
function primaryType(schema: Json): string | undefined {
  const type = schema.type
  if (typeof type === 'string') return type
  if (Array.isArray(type)) return type.find((t): t is string => typeof t === 'string' && t !== 'null')
  return undefined
}

export function parseSchema(schema: unknown): SchemaNode {
  if (!isRecord(schema)) return { kind: 'unsupported' }
  const common: Common = { title: str(schema.title), description: str(schema.description), default: schema.default }

  if (Array.isArray(schema.enum)) return { ...common, kind: 'enum', options: schema.enum }
  if ('const' in schema) return { ...common, kind: 'enum', options: [schema.const] }
  // Композиции и ссылки форма не разворачивает: оператор вводит JSON, сервер проверит по полной схеме
  if (['oneOf', 'anyOf', 'allOf', '$ref', 'if', 'not'].some((key) => key in schema)) return { ...common, kind: 'unsupported' }

  const type = primaryType(schema) ?? (isRecord(schema.properties) ? 'object' : undefined)
  switch (type) {
    case 'object': {
      if (!isRecord(schema.properties)) return { ...common, kind: 'unsupported' }
      // Путь поля в react-hook-form — через точку и скобки: имя `log.level` разъехалось бы по вложенным объектам и
      // ввод потерялся бы. Такой объект целиком редактируется как JSON
      if (Object.keys(schema.properties).some((name) => /[.[\]]/.test(name))) return { ...common, kind: 'unsupported' }
      const required = new Set(Array.isArray(schema.required) ? schema.required.filter((r) => typeof r === 'string') : [])
      // Порядок ключей схема не сохраняет: API хранит её в jsonb, а он переупорядочивает ключи. Поэтому порядок
      // полей задаёт форма: сначала обязательные, внутри групп — как пришли
      const properties = Object.entries(schema.properties)
        .map(([name, child]) => ({ name, node: parseSchema(child), required: required.has(name) }))
        .sort((a, b) => Number(b.required) - Number(a.required))
      return { ...common, kind: 'object', properties }
    }
    case 'array':
      // Кортежи (`prefixItems`) и массив без `items` — вне подмножества
      if (!isRecord(schema.items) || 'prefixItems' in schema) return { ...common, kind: 'unsupported' }
      return { ...common, kind: 'array', items: parseSchema(schema.items), minItems: num(schema.minItems), maxItems: num(schema.maxItems) }
    case 'string':
      return { ...common, kind: 'string', minLength: num(schema.minLength), maxLength: num(schema.maxLength), pattern: str(schema.pattern) }
    case 'number':
    case 'integer':
      return {
        ...common,
        kind: type,
        minimum: num(schema.minimum),
        maximum: num(schema.maximum),
        exclusiveMinimum: num(schema.exclusiveMinimum),
        exclusiveMaximum: num(schema.exclusiveMaximum),
      }
    case 'boolean':
      return { ...common, kind: 'boolean' }
    default:
      return { ...common, kind: 'unsupported' }
  }
}

/**
 * Значение формы из значения конфига (или из `default` схемы, если значения нет). Пустое обязательное — пустая
 * строка, а не выдуманное значение: заполнить его должен оператор.
 */
export function toFormValue(node: SchemaNode, value: unknown = node.default, required = true): FormValue {
  switch (node.kind) {
    case 'object': {
      // Необязательный объект без значения и без своего default — пустой: default детей не подставляется. Иначе
      // заполненные детьми поля сделали бы объект «введённым», и он ушёл бы в конфиг без участия оператора — а для
      // робота наличие блока часто значит «функция включена» (стоп-лосс). Сервер сам подставит default детей, если
      // оператор объект заполнит
      if (!required && !isRecord(value)) return emptyFormValue(node)
      // default объекта задаёт значения детей, но собственный default ребёнка — запасной вариант
      const source = isRecord(value) ? value : {}
      return Object.fromEntries(
        node.properties.map((p) => [p.name, toFormValue(p.node, p.name in source ? source[p.name] : p.node.default, p.required)]),
      )
    }
    case 'array': {
      // Пустые элементы по minItems — только обязательному массиву: необязательный оператор может пропустить
      const prefill = required ? (node.minItems ?? 0) : 0
      const items = Array.isArray(value) ? value : Array.from({ length: prefill }, () => node.items.default)
      return items.map((item) => ({ value: toFormValue(node.items, item) }))
    }
    case 'string':
      return typeof value === 'string' ? value : ''
    case 'number':
    case 'integer':
      return typeof value === 'number' ? String(value) : ''
    case 'boolean':
      return typeof value === 'boolean' ? value : false
    case 'enum': {
      const index = node.options.findIndex((option) => sameValue(option, value))
      return index >= 0 ? String(index) : ''
    }
    case 'unsupported':
      return value === undefined ? '' : JSON.stringify(value, null, 2)
  }
}

/**
 * Ничего не введено: пустые поля, пустой массив, флажок в положении по умолчанию. Необязательный объект или
 * массив без ввода в конфиг не попадает и не проверяется — иначе его обязательные дети или `minItems` мешали бы
 * пропустить его целиком.
 */
export function isBlank(node: SchemaNode, value: unknown): boolean {
  switch (node.kind) {
    case 'object': {
      const source = isRecord(value) ? value : {}
      return node.properties.every((p) => isBlank(p.node, source[p.name]))
    }
    case 'array':
      return !Array.isArray(value) || value.every((item) => isBlank(node.items, isRecord(item) ? item.value : undefined))
    case 'boolean':
      return value === undefined || value === (node.default === true)
    // Пустая строка — только пустая: строка из пробелов — ввод, как и в `toConfig`
    case 'string':
      return typeof value !== 'string' || value === ''
    default:
      return typeof value !== 'string' || value.trim() === ''
  }
}

/** Значение формы без ввода и без default — для необязательного объекта, которого оператор не трогал */
function emptyFormValue(node: SchemaNode): FormValue {
  switch (node.kind) {
    case 'object':
      return Object.fromEntries(node.properties.map((p) => [p.name, emptyFormValue(p.node)]))
    case 'array':
      return []
    case 'boolean':
      // Положение по умолчанию — «не тронут» для `isBlank`
      return node.default === true
    default:
      return ''
  }
}

/** Равенство значений схемы: enum и const бывают объектами и массивами */
function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  return typeof a === 'object' && a !== null && typeof b === 'object' && b !== null && JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Конфиг из значения формы. Пустое поле опускается — сервер подставит `default` или сообщит об обязательном.
 * Необязательные объект и массив без ввода опускаются целиком, необязательный флажок без `default` — если не
 * отмечен. Вызывается после проверки `formSchema`, поэтому числа и JSON уже корректны.
 */
export function toConfig(node: SchemaNode, value: unknown, required = true): unknown {
  switch (node.kind) {
    case 'object': {
      if (!required && isBlank(node, value)) return undefined
      const source = isRecord(value) ? value : {}
      const entries = node.properties
        .map((p) => [p.name, toConfig(p.node, source[p.name], p.required)] as const)
        .filter(([, child]) => child !== undefined)
      return Object.fromEntries(entries)
    }
    case 'array':
      if (!Array.isArray(value) || (!required && isBlank(node, value))) return undefined
      return value.map((item) => toConfig(node.items, isRecord(item) ? item.value : undefined, true))
    case 'string':
      return typeof value === 'string' && value !== '' ? value : undefined
    case 'number':
    case 'integer':
      return typeof value === 'string' && value.trim() !== '' ? Number(value) : undefined
    case 'boolean':
      if (typeof value !== 'boolean') return undefined
      return !required && node.default === undefined && !value ? undefined : value
    case 'enum':
      return typeof value === 'string' && value !== '' ? node.options[Number(value)] : undefined
    case 'unsupported':
      return typeof value === 'string' && value.trim() !== '' ? JSON.parse(value) : undefined
  }
}

export const MESSAGES = {
  required: 'Обязательное поле',
  number: 'Нужно число',
  integer: 'Нужно целое число',
  json: 'Некорректный JSON',
  pattern: 'Не подходит под формат',
} as const

function numberProblem(node: Extract<SchemaNode, { kind: 'number' | 'integer' }>, n: number): string | undefined {
  if (!Number.isFinite(n)) return MESSAGES.number
  if (node.kind === 'integer' && !Number.isInteger(n)) return MESSAGES.integer
  if (node.minimum !== undefined && n < node.minimum) return `Не меньше ${node.minimum}`
  if (node.maximum !== undefined && n > node.maximum) return `Не больше ${node.maximum}`
  if (node.exclusiveMinimum !== undefined && n <= node.exclusiveMinimum) return `Больше ${node.exclusiveMinimum}`
  if (node.exclusiveMaximum !== undefined && n >= node.exclusiveMaximum) return `Меньше ${node.exclusiveMaximum}`
  return undefined
}

function patternMatches(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern, 'u').test(value)
  } catch {
    // Выражение, которое браузер не разбирает, проверит сервер
    return true
  }
}

const DECIMAL = /^-?\d+(\.\d+)?$/

/** Необязательный объект или массив: без ввода пропускается, с вводом — проверяется целиком */
function skippable(node: SchemaNode, strict: z.ZodType): z.ZodType {
  return z.unknown().superRefine((value, ctx) => {
    if (isBlank(node, value)) return
    const result = strict.safeParse(value)
    if (!result.success) for (const issue of result.error.issues) ctx.addIssue({ code: 'custom', message: issue.message, path: issue.path })
  })
}

/**
 * zod-схема значения формы: обязательные поля, числа, границы, длины, формат и размер массивов. Это подсказка
 * оператору до отправки; полную проверку делает сервер. Элемент массива всегда обязателен: пустая строка в
 * списке — забытое значение, его надо заполнить или удалить.
 */
export function formSchema(node: SchemaNode, required = true): z.ZodType {
  if (!required && (node.kind === 'object' || node.kind === 'array')) return skippable(node, formSchema(node, true))
  switch (node.kind) {
    case 'object':
      return z.object(Object.fromEntries(node.properties.map((p) => [p.name, formSchema(p.node, p.required)])))
    case 'array': {
      let items = z.array(z.object({ value: formSchema(node.items, true) }))
      if (node.minItems !== undefined) items = items.min(node.minItems, `Нужно не меньше ${node.minItems} элем.`)
      if (node.maxItems !== undefined) items = items.max(node.maxItems, `Не больше ${node.maxItems} элем.`)
      return items
    }
    case 'string':
      return z.string().superRefine((value, ctx) => {
        if (value === '') {
          if (required) ctx.addIssue({ code: 'custom', message: MESSAGES.required })
          return
        }
        if (node.minLength !== undefined && value.length < node.minLength)
          ctx.addIssue({ code: 'custom', message: `Не короче ${node.minLength} симв.` })
        if (node.maxLength !== undefined && value.length > node.maxLength)
          ctx.addIssue({ code: 'custom', message: `Не длиннее ${node.maxLength} симв.` })
        if (node.pattern !== undefined && !patternMatches(node.pattern, value)) ctx.addIssue({ code: 'custom', message: MESSAGES.pattern })
      })
    case 'number':
    case 'integer':
      return z.string().superRefine((value, ctx) => {
        if (value.trim() === '') {
          if (required) ctx.addIssue({ code: 'custom', message: MESSAGES.required })
          return
        }
        // Только десятичная запись: Number() принял бы и `0x1A`, и `1e3`, а оператор их вряд ли имел в виду
        const problem = DECIMAL.test(value.trim()) ? numberProblem(node, Number(value)) : MESSAGES.number
        if (problem) ctx.addIssue({ code: 'custom', message: problem })
      })
    case 'boolean':
      return z.boolean()
    case 'enum':
      return z.string().refine((value) => !required || value !== '', MESSAGES.required)
    case 'unsupported':
      return z.string().superRefine((value, ctx) => {
        if (value.trim() === '') {
          if (required) ctx.addIssue({ code: 'custom', message: MESSAGES.required })
          return
        }
        try {
          JSON.parse(value)
        } catch {
          ctx.addIssue({ code: 'custom', message: MESSAGES.json })
        }
      })
  }
}

/** Подпись варианта enum: строка как есть, остальное — JSON */
export function optionLabel(option: unknown): string {
  return typeof option === 'string' ? option : JSON.stringify(option)
}
