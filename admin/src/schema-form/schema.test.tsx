import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { FormProvider, useForm } from 'react-hook-form'
import { SchemaFields } from './SchemaField'
import { formSchema, parseSchema, type SchemaNode, toConfig, toFormValue } from './schema'

// Схемы — копии конфигов роботов из bots/templates: форма должна понимать именно их
const bita = {
  type: 'object',
  required: ['figi'],
  additionalProperties: false,
  properties: {
    figi: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Инструменты, FIGI' },
    strategy: { enum: ['gamble', 'crumble', 'tumble'], default: 'gamble' },
    sellOnExit: { type: 'boolean', default: false },
    logLevel: { enum: ['DEBUG', 'INFO', 'WARN', 'ERROR'], default: 'INFO' },
  },
}

const contest = {
  type: 'object',
  required: ['instruments'],
  properties: {
    instruments: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['figi'],
        properties: {
          figi: { type: 'string' },
          depth: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
          dominanceRatio: { type: 'number', exclusiveMinimum: 1, default: 3 },
          profitPercentage: { type: 'number', exclusiveMinimum: 0, default: 0.01 },
        },
      },
    },
    logLevel: { enum: ['debug', 'info', 'warn', 'error'], default: 'info' },
  },
}

function Host({ node }: { node: SchemaNode }) {
  const form = useForm<Record<string, unknown>>({ defaultValues: { config: toFormValue(node) } })
  return (
    <FormProvider {...form}>
      <SchemaFields node={node} name="config" />
    </FormProvider>
  )
}

function issues(node: SchemaNode, value: unknown): Record<string, string> {
  const result = formSchema(node).safeParse(value)
  if (result.success) return {}
  return Object.fromEntries(result.error.issues.map((issue) => [issue.path.join('.'), issue.message]))
}

describe('форма по JSON Schema', () => {
  test('значения по умолчанию: default схемы, enum — индексом, обязательный массив — пустые элементы по minItems', () => {
    const node = parseSchema(bita)
    expect(toFormValue(node)).toEqual({ figi: [{ value: '' }], strategy: '0', sellOnExit: false, logLevel: '1' })
  })

  test('массив объектов: элемент получает default своих полей, числа — строкой ввода', () => {
    const node = parseSchema(contest)
    expect(toFormValue(node)).toEqual({
      instruments: [{ value: { figi: '', depth: '20', dominanceRatio: '3', profitPercentage: '0.01' } }],
      logLevel: '1',
    })
  })

  test('обязательные поля: пустое — ошибка, необязательное пустое — нет; элемент массива всегда обязателен', () => {
    const node = parseSchema(contest)
    const value = toFormValue(node)
    expect(issues(node, value)).toEqual({ 'instruments.0.value.figi': 'Обязательное поле' })

    const optional = parseSchema({ type: 'object', properties: { note: { type: 'string' }, n: { type: 'number' } } })
    expect(issues(optional, { note: '', n: '' })).toEqual({})

    const figi = parseSchema(bita)
    expect(issues(figi, { figi: [], strategy: '0', sellOnExit: false, logLevel: '' })).toEqual({ figi: 'Нужно не меньше 1 элем.' })
  })

  test('числа: не число, дробь в integer и границы схемы', () => {
    const node = parseSchema(contest)
    const item = (depth: string, dominanceRatio: string) => ({
      instruments: [{ value: { figi: 'BBG', depth, dominanceRatio, profitPercentage: '0.01' } }],
      logLevel: '1',
    })
    expect(issues(node, item('abc', '3'))).toEqual({ 'instruments.0.value.depth': 'Нужно число' })
    expect(issues(node, item('2.5', '3'))).toEqual({ 'instruments.0.value.depth': 'Нужно целое число' })
    expect(issues(node, item('51', '1'))).toEqual({
      'instruments.0.value.depth': 'Не больше 50',
      'instruments.0.value.dominanceRatio': 'Больше 1',
    })
    expect(issues(node, item('50', '1.5'))).toEqual({})
  })

  test('в конфиг: числа — числами, enum — значением варианта, пустое необязательное опускается', () => {
    const node = parseSchema(contest)
    const config = toConfig(node, {
      instruments: [{ value: { figi: 'BBG004730N88', depth: '10', dominanceRatio: '', profitPercentage: '' } }],
      logLevel: '',
    })
    expect(config).toEqual({ instruments: [{ figi: 'BBG004730N88', depth: 10 }] })

    const bitaNode = parseSchema(bita)
    expect(toConfig(bitaNode, { figi: [{ value: 'A' }, { value: 'B' }], strategy: '2', sellOnExit: true, logLevel: '0' })).toEqual({
      figi: ['A', 'B'],
      strategy: 'tumble',
      sellOnExit: true,
      logLevel: 'DEBUG',
    })
  })

  test('туда и обратно: существующий конфиг развёртывания восстанавливается без потерь', () => {
    const node = parseSchema(bita)
    const config = { figi: ['BBG004730N88'], logLevel: 'INFO', strategy: 'gamble', sellOnExit: false }
    expect(toConfig(node, toFormValue(node, config))).toEqual(config)
  })

  test('непонятное схеме (oneOf) — поле JSON: значение уходит как есть, некорректный JSON — ошибка', () => {
    const node = parseSchema({ type: 'object', properties: { extra: { oneOf: [{ type: 'string' }, { type: 'number' }] } } })
    expect(node.kind === 'object' && node.properties[0]?.node.kind).toBe('unsupported')
    expect(toConfig(node, { extra: '42' })).toEqual({ extra: 42 })
    expect(issues(node, { extra: '{' })).toEqual({ extra: 'Некорректный JSON' })
  })

  test('необязательные объект и массив без ввода опускаются и не проверяются; с вводом — проверяются целиком', () => {
    const node = parseSchema({
      type: 'object',
      properties: {
        risk: { type: 'object', required: ['limit'], properties: { limit: { type: 'number' }, hard: { type: 'boolean' } } },
        tags: { type: 'array', minItems: 2, items: { type: 'string' } },
        dryRun: { type: 'boolean' },
      },
    })
    const blank = toFormValue(node)
    expect(issues(node, blank)).toEqual({})
    expect(toConfig(node, blank)).toEqual({})

    const filled = { risk: { limit: '', hard: true }, tags: [{ value: 'a' }], dryRun: true }
    expect(issues(node, filled)).toEqual({ 'risk.limit': 'Обязательное поле', tags: 'Нужно не меньше 2 элем.' })
    expect(toConfig(node, { ...filled, risk: { limit: '5', hard: false } })).toEqual({ risk: { limit: 5 }, tags: ['a'], dryRun: true })
  })

  test('необязательный объект с default у детей без ввода в конфиг не попадает: оператор функцию не включал', () => {
    const node = parseSchema({
      type: 'object',
      properties: {
        stopLoss: {
          type: 'object',
          properties: {
            percent: { type: 'number', default: 5 },
            enabled: { type: 'boolean', default: true },
            note: { type: 'string', default: 'x' },
          },
        },
      },
    })

    expect(toConfig(node, toFormValue(node))).toEqual({})
    // Оператор заполнил одно поле — объект уходит, прочие default подставит сервер
    expect(toConfig(node, { stopLoss: { percent: '3', enabled: true, note: '' } })).toEqual({ stopLoss: { percent: 3, enabled: true } })
    // Существующий конфиг развёртывания с объектом восстанавливается как есть
    expect(toConfig(node, toFormValue(node, { stopLoss: { percent: 7 } }))).toEqual({ stopLoss: { percent: 7, enabled: true, note: 'x' } })
  })

  test('строка из пробелов — ввод и в обязательном поле, и в необязательном объекте; enum с объектным default выбирается', () => {
    const node = parseSchema({
      type: 'object',
      properties: {
        extra: { type: 'object', properties: { tag: { type: 'string' } } },
        mode: { enum: [{ a: 1 }, { a: 2 }], default: { a: 2 } },
      },
    })
    expect(toConfig(node, { ...(toFormValue(node) as object), extra: { tag: '  ' } })).toMatchObject({ extra: { tag: '  ' } })
    expect((toFormValue(node) as Record<string, unknown>).mode).toBe('1')
  })

  test('имя свойства с точкой или скобкой — объект целиком полем JSON: путь формы его не разобрал бы', () => {
    const node = parseSchema({ type: 'object', properties: { log: { type: 'object', properties: { 'log.level': { type: 'string' } } } } })
    expect(node.kind === 'object' && node.properties[0]?.node.kind).toBe('unsupported')
  })

  test('число — только десятичная запись', () => {
    const node = parseSchema({ type: 'object', properties: { n: { type: 'number' } } })
    expect(issues(node, { n: '0x1A' })).toEqual({ n: 'Нужно число' })
    expect(issues(node, { n: '1e3' })).toEqual({ n: 'Нужно число' })
    expect(issues(node, { n: '-2.5' })).toEqual({})
  })

  test('разметка: обязательные поля помечены, массив объектов рисует поля элемента, enum — варианты индексами', () => {
    const html = renderToStaticMarkup(<Host node={parseSchema(contest)} />)
    expect(html).toContain('name="config.instruments.0.value.figi"')
    // Значения register ставит в DOM после монтирования, в разметке их нет: они проверены через toFormValue
    expect(html).toContain('inputMode="numeric" name="config.instruments.0.value.depth"')
    expect(html).toContain('>instruments<span class="text-red-600"> *</span>')
    expect(html).toContain('<option value="1">info</option>')
    expect(html).toContain('+ Добавить')
  })
})
