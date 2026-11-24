import { z } from 'zod'
import { SecretValue } from './secret-value'

export const ProcessRole = {
  HTTP: 'http',
  WORKER: 'worker',
  RELAY: 'relay',
  RECONCILER: 'reconciler',
} as const
export type ProcessRole = (typeof ProcessRole)[keyof typeof ProcessRole]

const port = z
  .string()
  .regex(/^\d{1,5}$/, 'must be an integer port')
  .transform(Number)
  .pipe(z.number().min(1).max(65535))

/** Мастер-ключ шифрования секретов: ровно 32 байта в base64 (`openssl rand -base64 32`) */
const masterKey = z
  .string()
  .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'must be base64')
  .transform((value) => Buffer.from(value, 'base64'))
  .refine((key) => key.length === 32, 'must decode to exactly 32 bytes')
  .transform((key) => new SecretValue(key))

const flag = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true')

/**
 * Окружение читается и проверяется один раз при старте. Процесс с битой переменной не поднимается:
 * лучше упасть на деплое, чем узнать о пустом мастер-ключе на первом сохранённом секрете.
 *
 * `NODE_ENV` здесь нет намеренно: под `bun test` Bun ставит его в `test`, а в образе его легко
 * забыть — признак окружения из него ненадёжный. Всё, что отличает разработку, — явные флаги.
 */
const schema = z
  .object({
    PROCESS_ROLE: z.enum([ProcessRole.HTTP, ProcessRole.WORKER, ProcessRole.RELAY, ProcessRole.RECONCILER]).default(ProcessRole.HTTP),
    PORT: port.default(4000),
    METRICS_PORT: port.default(9464),
    // Порт метрик без авторизации: наружу его не публиковать (см. infra/dokploy/README.md)
    METRICS_HOST: z.string().min(1).default('0.0.0.0'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    // Человекочитаемые логи для локальной разработки. pino-pretty — dev-зависимость
    LOG_PRETTY: flag,
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    // http-адрес назначения: только для локальной разработки, ключ Dokploy по открытому каналу не уходит
    DESTINATIONS_ALLOW_HTTP: flag,
    SECRETS_MASTER_KEY: masterKey,
    // Номер ключа в конвертах: при ротации новый ключ получает новый номер (см. shared/crypto)
    SECRETS_MASTER_KEY_ID: z
      .string()
      .regex(/^\d{1,3}$/)
      .transform(Number)
      .pipe(z.number().min(1).max(255))
      .default(1),
  })
  .refine((config) => config.PORT !== config.METRICS_PORT, { path: ['METRICS_PORT'], message: 'must differ from PORT' })

export type AppConfig = Readonly<z.infer<typeof schema>>

export const APP_CONFIG = Symbol('APP_CONFIG')

const databaseOnly = z.object({ DATABASE_URL: schema.shape.DATABASE_URL })

/** Для разовых команд (миграции): им не нужны ни секреты, ни порты, и требовать их незачем */
export function loadDatabaseConfig(env: Record<string, string | undefined> = process.env): { DATABASE_URL: string } {
  const parsed = databaseOnly.safeParse(env)
  if (!parsed.success) throw new Error(`invalid environment: DATABASE_URL: ${parsed.error.issues[0]?.message ?? 'invalid'}`)

  return parsed.data
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = schema.safeParse(env)
  if (!parsed.success) {
    // Значения не печатаются: в окружении лежат секреты
    const problems = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')
    throw new Error(`invalid environment: ${problems}`)
  }

  return Object.freeze(parsed.data)
}
