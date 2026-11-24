/**
 * Маскирование секретов в логах на любой глубине: по имени поля и по виду значения.
 *
 * Список путей pino (`*.apiKey`) ловит секрет только на заранее известной глубине, а адаптеры
 * кладут в лог ошибки и запросы произвольной вложенности. Поэтому маска идёт от имени поля
 * (`apiKey`, `tokens`, `DATABASE_URL`) и от вида строки (`Bearer …`, пароль в URL, токен T-Invest).
 *
 * Это страховка, а не разрешение логировать объекты с секретами. Секрет в сообщении ошибки
 * или в пути URL маска не найдёт: секреты в путь не кладутся (вебхуки — только заголовок).
 */
const SECRET_WORD =
  /(^|[-_.])(authorization|auth|bearer|cookies?|set-cookie|passwords?|passwd|pwd|pass|passphrase|secrets?|tokens?|signatures?|signing[-_]?key|hmac|jwt|api[-_]?keys?|apikeys?|private[-_]?key|master[-_]?key|secret[-_]?key|access[-_]?key|credentials?|session|session[-_]?id|dsn|connection[-_]?string|database[-_]?url)($|[-_.])/i
// Хвост camelCase-имени: tinvestToken, dokployApiKeys, connectionString
const CAMEL_SECRET =
  /(password|passphrase|secrets?|tokens?|signature|apikeys?|privatekey|masterkey|secretkey|accesskey|credentials?|sessionid|connectionstring|databaseurl)$/i
// Голова camelCase-имени: tokenValue, apiKeyPlain, privateKeyPem, secretData
const CAMEL_HEAD = /^(tokens?|apiKeys?|secrets?|privateKey|password|passphrase|credentials?)[A-Z]/
// Служебные поля рядом с секретами — не секреты: SECRETS_MASTER_KEY_ID, api_key_hint, apiKeyHint, tokenCount
const NOT_SECRET_SNAKE = /[-_](id|hint|count|type|version|length|valid|at)$/i
const NOT_SECRET_CAMEL = /[a-z](Id|Hint|Count|Type|Version|Length|Valid|At)$/
// Флаги и лимиты: is_secret, hasToken, max_tokens
const NOT_SECRET_PREFIX = /^(is|has|max|min|num)([-_]|[A-Z])/

/** Значения, которые выглядят как секрет, где бы они ни лежали */
const SECRET_VALUES: readonly [RegExp, string][] = [
  // Схема авторизации HTTP регистронезависима
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [redacted]'],
  // Учётные данные в URL до последнего `@` в authority: пароль с неэкранированной `@` не утекает хвостом
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/?#]*@/gi, '$1[redacted]@'],
  [/\bt\.[A-Za-z0-9_-]{20,}/g, 't.[redacted]'],
]

export const REDACTED = '[redacted]'
const MAX_DEPTH = 8

export function isSecretKey(key: string): boolean {
  // Идентификатор сессии — сам по себе пропуск, хоть и кончается на id
  if (/session[-_]?id$/i.test(key)) return true
  if (NOT_SECRET_SNAKE.test(key) || NOT_SECRET_CAMEL.test(key) || NOT_SECRET_PREFIX.test(key)) return false

  return SECRET_WORD.test(key) || CAMEL_SECRET.test(key) || CAMEL_HEAD.test(key)
}

export function redactString(value: string): string {
  return SECRET_VALUES.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value)
}

/**
 * Копия значения с замаскированными секретами. Обходит простые объекты, массивы, ошибки
 * (с `cause` и `errors`), `Map` и `Headers`. Экземпляры прочих классов (сокеты, ответы HTTP)
 * не обходит, а описывает именем класса: их содержимое — дело сериализаторов, а обход
 * живого `ServerResponse` уводит в сокет и сервер.
 */
export function redactDeep(value: unknown, depth = 0, path: object[] = []): unknown {
  if (typeof value === 'string') return redactString(value)
  if (value === null || typeof value !== 'object') return value
  if (depth >= MAX_DEPTH) return '[depth limit]'
  // Цикл — только объект, который уже есть на текущем пути; общий объект в двух ветках — не цикл
  if (path.includes(value)) return '[circular]'

  const inner = [...path, value]
  const walk = (item: unknown) => redactDeep(item, depth + 1, inner)

  if (Array.isArray(value)) return value.map(walk)
  if (value instanceof Date) return value
  if (ArrayBuffer.isView(value)) return `[binary ${value.byteLength} bytes]`
  if (value instanceof Map) return walkEntries(value.entries(), walk)
  if (typeof Headers !== 'undefined' && value instanceof Headers) return walkEntries(value.entries(), walk)

  if (value instanceof Error) {
    const described: Record<string, unknown> = {
      type: value.name,
      message: redactString(value.message),
      stack: value.stack && redactString(value.stack),
    }
    if (value.cause !== undefined) described.cause = walk(value.cause)
    if (value instanceof AggregateError) described.errors = walk(value.errors)

    return { ...described, ...walkEntries(Object.entries(value), walk) }
  }

  const prototype: unknown = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    const name = (prototype as { constructor?: { name?: string } }).constructor?.name

    return `[${name ?? 'object'}]`
  }

  return walkEntries(Object.entries(value), walk)
}

function walkEntries(entries: Iterable<[unknown, unknown]>, walk: (item: unknown) => unknown): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [rawKey, item] of entries) {
    const key = String(rawKey)
    result[key] = isSecretKey(key) && item !== undefined && item !== null ? REDACTED : walk(item)
  }

  return result
}

/** Путь без query: в строке запроса бывают токены, а для разбора хватает пути и метода */
export function pathOnly(url: string | undefined): string | undefined {
  if (url === undefined) return undefined
  const index = url.indexOf('?')

  return index === -1 ? url : `${url.slice(0, index)}?[redacted]`
}
