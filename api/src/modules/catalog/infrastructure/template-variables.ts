import Handlebars from 'handlebars'

/**
 * Проверка шаблонов конфига робота (Handlebars) при синхронизации каталога: шаблон компилируется, а каждое
 * обращение к переменной сверяется с допустимым набором. Опечатка (`{{ config.figis }}`) или переменная,
 * которой платформа не даёт, отклоняется сразу, а не рендерится пустой строкой в конфиг боевого робота.
 *
 *   config.<поле>             — поле верхнего уровня `config.schema` (внутри {{#each config.<массив>}} —
 *                               поля элементов массива по `items.properties`)
 *   customer.accountId, customer.sandbox, secret.tinvestToken, platform.tinvestAddress
 */
export const PLATFORM_VARIABLES = ['customer.accountId', 'customer.sandbox', 'secret.tinvestToken', 'platform.tinvestAddress'] as const

const INLINE_HELPERS = new Set(['join'])
const BLOCK_HELPERS = new Set(['each', 'if', 'unless'])
/** Служебные переменные `each`; `@root` и прочие `@`-переменные обходили бы проверку имён */
const LOOP_DATA = new Set(['index', 'first', 'last', 'key'])

type Scope = { readonly kind: 'root' } | { readonly kind: 'item'; readonly fields: ReadonlySet<string>; readonly parent: Scope }

interface Schema {
  readonly type?: unknown
  readonly properties?: Record<string, Schema>
  readonly items?: Schema
}

/** Ошибки шаблона: пустой список — шаблон годен */
export function checkTemplate(source: string, configSchema: Record<string, unknown>): string[] {
  let ast: hbs.AST.Program
  try {
    ast = Handlebars.parse(source)
  } catch (error) {
    return [`does not compile: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`]
  }

  const errors: string[] = []
  walkProgram(ast, { kind: 'root' }, asSchema(configSchema), errors)
  return errors
}

function walkProgram(program: hbs.AST.Program | undefined, scope: Scope, schema: Schema, errors: string[]): void {
  for (const statement of program?.body ?? []) walkStatement(statement, scope, schema, errors)
}

function walkStatement(statement: hbs.AST.Statement, scope: Scope, schema: Schema, errors: string[]): void {
  if (isMustache(statement)) {
    const mustache = statement
    if (hasHash(mustache.hash)) errors.push('hash arguments are not allowed')
    const params = mustache.params ?? []
    if (params.length === 0 && isPath(mustache.path)) {
      checkPath(mustache.path, scope, schema, errors)
      return
    }
    const helper = nameOf(mustache.path)
    if (!INLINE_HELPERS.has(helper)) errors.push(`helper "${helper}" is not allowed`)
    for (const param of params) checkExpression(param, scope, schema, errors)
    return
  }

  if (isBlock(statement)) {
    const block = statement
    const helper = nameOf(block.path)
    if (!BLOCK_HELPERS.has(helper)) {
      errors.push(`block helper "${helper}" is not allowed`)
      return
    }
    if (hasHash(block.hash)) errors.push('hash arguments are not allowed')
    if (block.params.length !== 1) errors.push(`{{#${helper}}} takes exactly one argument`)
    const [subject] = block.params
    if (subject) checkExpression(subject, scope, schema, errors)

    let inner = scope
    if (helper === 'each' && subject && isPath(subject)) {
      const items = itemsOf(subject, scope, schema)
      if (items) inner = { kind: 'item', fields: new Set(Object.keys(items.properties ?? {})), parent: scope }
      else errors.push(`{{#each ${subject.original}}} must iterate an array of objects from config.schema`)
    }
    walkProgram(block.program, inner, schema, errors)
    walkProgram(block.inverse, scope, schema, errors)
    return
  }

  if (
    statement.type === 'PartialStatement' ||
    statement.type === 'PartialBlockStatement' ||
    statement.type === 'Decorator' ||
    statement.type === 'DecoratorBlock'
  ) {
    errors.push('partials and decorators are not allowed')
  }
}

function checkExpression(expression: hbs.AST.Expression, scope: Scope, schema: Schema, errors: string[]): void {
  if (isPath(expression)) checkPath(expression, scope, schema, errors)
  else if (expression.type === 'SubExpression') errors.push('subexpressions are not allowed')
}

function checkPath(path: hbs.AST.PathExpression, scope: Scope, schema: Schema, errors: string[]): void {
  if (path.data) {
    const [name] = path.parts
    if (scope.kind === 'item' && path.parts.length === 1 && name !== undefined && LOOP_DATA.has(name)) return
    errors.push(`data variable "${path.original}" is not allowed`)
    return
  }
  // `../` выше корня Handlebars молча рендерит пустым: такой путь — ошибка, а не корень
  let target: Scope | null = scope
  for (let level = 0; level < path.depth && target; level++) target = target.kind === 'item' ? target.parent : null
  const name = path.parts.join('.')
  if (target && resolves(path.parts, target, schema)) return

  errors.push(`unknown variable "${path.original}"${name === path.original ? '' : ` (${name})`}`)
}

function resolves(parts: readonly string[], scope: Scope, schema: Schema): boolean {
  if (scope.kind === 'item') return parts.length === 1 && parts[0] !== undefined && scope.fields.has(parts[0])

  const name = parts.join('.')
  if ((PLATFORM_VARIABLES as readonly string[]).includes(name)) return true
  return parts.length === 2 && parts[0] === 'config' && parts[1] !== undefined && Object.hasOwn(schema.properties ?? {}, parts[1])
}

function itemsOf(path: hbs.AST.PathExpression, scope: Scope, schema: Schema): Schema | null {
  if (scope.kind !== 'root' || path.parts.length !== 2 || path.parts[0] !== 'config') return null
  const key = path.parts[1] ?? ''
  const field = schema.properties && Object.hasOwn(schema.properties, key) ? schema.properties[key] : undefined
  if (field?.type !== 'array' || field.items?.type !== 'object') return null

  return field.items
}

function hasHash(hash: hbs.AST.Hash | undefined): boolean {
  return (hash?.pairs.length ?? 0) > 0
}

function nameOf(expression: hbs.AST.Expression): string {
  return isPath(expression) ? expression.original : expression.type
}

function asSchema(value: Record<string, unknown>): Schema {
  return value
}

/** Узлы Handlebars не размечены как объединение: сужение — проверкой поля `type`, а не приведением */
function isMustache(node: hbs.AST.Statement): node is hbs.AST.MustacheStatement {
  return node.type === 'MustacheStatement'
}

function isBlock(node: hbs.AST.Statement): node is hbs.AST.BlockStatement {
  return node.type === 'BlockStatement'
}

function isPath(node: hbs.AST.Expression): node is hbs.AST.PathExpression {
  return node.type === 'PathExpression'
}
