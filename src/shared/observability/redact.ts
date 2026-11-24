/**
 * Маскирование секретов в логах по имени ключа на любой глубине.
 *
 * Список путей pino (`*.apiKey`) ловит секрет только на заранее известной глубине, а адаптеры
 * кладут в лог ошибки и запросы произвольной вложенности. Поэтому маска идёт от имени поля:
 * ключ похож на секрет — значение заменяется, где бы он ни лежал.
 */
const SECRET_KEY =
  /(^|[-_])(authorization|cookie|set-cookie|password|passwd|secret|token|signature|api[-_]?key|apikey|private[-_]?key|master[-_]?key|dsn)($|[-_])/i
// Хвост camelCase-имени: tinvestToken, dokployApiKey. Регистр первой буквы не важен
const CAMEL_SECRET = /(password|secret|token|signature|apikey|privatekey|masterkey)$/i

export const REDACTED = '[redacted]'
const MAX_DEPTH = 8

export function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key) || CAMEL_SECRET.test(key)
}

export function redactDeep(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== 'object') return value
  if (depth >= MAX_DEPTH) return '[depth limit]'
  if (seen.has(value)) return '[circular]'
  seen.add(value)

  if (Array.isArray(value)) return value.map((item) => redactDeep(item, depth + 1, seen))
  if (value instanceof Date || ArrayBuffer.isView(value)) return value

  const source: Record<string, unknown> =
    value instanceof Error
      ? { type: value.name, message: value.message, stack: value.stack, ...Object.fromEntries(Object.entries(value)) }
      : (value as Record<string, unknown>)

  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(source)) {
    result[key] = isSecretKey(key) && item !== undefined && item !== null ? REDACTED : redactDeep(item, depth + 1, seen)
  }

  return result
}

/** Путь без query: в строке запроса бывают токены, а для разбора хватает пути и метода */
export function pathOnly(url: string | undefined): string | undefined {
  if (url === undefined) return undefined
  const index = url.indexOf('?')

  return index === -1 ? url : `${url.slice(0, index)}?[redacted]`
}
