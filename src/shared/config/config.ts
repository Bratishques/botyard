import { z } from 'zod'

export const ProcessRole = {
  HTTP: 'http',
  WORKER: 'worker',
  RELAY: 'relay',
  RECONCILER: 'reconciler',
} as const
export type ProcessRole = (typeof ProcessRole)[keyof typeof ProcessRole]

const port = z.coerce.number().int().min(1).max(65535)

/**
 * Окружение читается и проверяется один раз при старте. Процесс с битой переменной не поднимается:
 * лучше упасть на деплое, чем узнать о пустом мастер-ключе на первом сохранённом секрете.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PROCESS_ROLE: z.enum([ProcessRole.HTTP, ProcessRole.WORKER, ProcessRole.RELAY, ProcessRole.RECONCILER]).default(ProcessRole.HTTP),
  PORT: port.default(4000),
  METRICS_PORT: port.default(9464),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
})

export type AppConfig = Readonly<z.infer<typeof schema>>

export const APP_CONFIG = Symbol('APP_CONFIG')

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = schema.safeParse(env)
  if (!parsed.success) {
    // Значения не печатаются: в окружении лежат секреты
    const problems = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')
    throw new Error(`invalid environment: ${problems}`)
  }

  return Object.freeze(parsed.data)
}
