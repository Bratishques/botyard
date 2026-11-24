import type { RobotRuntime } from './robot-runtime'

/** Куда разворачивать: адрес и ключ Dokploy (ключ открыт только на время шага), окружение и сервер */
export interface PlatformTarget {
  readonly baseUrl: string
  readonly apiKey: string
  readonly environmentId: string
  readonly serverId: string | null
}

export interface PlatformApp {
  readonly id: string
  readonly appName: string
}

/** Деплой Dokploy: `running` — идёт, `done` — готово, `error` — сборка или запуск упали */
export interface PlatformDeployment {
  readonly id: string
  readonly status: string
}

export interface AppSpec {
  readonly source: { readonly gitUrl: string; readonly ref: string }
  readonly build: { readonly dockerfile: string; readonly context: string }
  readonly runtime: RobotRuntime
}

/**
 * Ошибка платформы для саги. `retryable` — исход неизвестен или временный (сеть, таймаут, 5xx, лимит):
 * шаг повторяется. Иначе — отказ (ключ не принят, запрос отклонён, непонятный ответ): операция падает.
 */
export class PlatformError extends Error {
  override readonly name = 'PlatformError'

  constructor(
    readonly retryable: boolean,
    message: string,
    readonly retryAfterMs?: number,
    options?: { cause?: unknown },
  ) {
    super(message, options)
  }
}

/**
 * Платформа развёртывания (Dokploy). Методы — то, что нужно шагам саги; идемпотентность каждого шага
 * обеспечивает сага, а не адаптер.
 */
export interface DeploymentPlatform {
  /** Приложения Botyard с этим appName в окружении назначения (Dokploy дописывает к имени хвост) */
  findApps(target: PlatformTarget, appName: string): Promise<PlatformApp[]>
  createApp(target: PlatformTarget, app: { appName: string; name: string; description: string }): Promise<PlatformApp>
  configure(target: PlatformTarget, appId: string, spec: AppSpec): Promise<void>
  /** Последний деплой приложения или `null`, если деплоев не было */
  latestDeployment(target: PlatformTarget, appId: string): Promise<PlatformDeployment | null>
  deploy(target: PlatformTarget, appId: string): Promise<void>
  start(target: PlatformTarget, appId: string): Promise<void>
  stop(target: PlatformTarget, appId: string): Promise<void>
  /** Удалить; приложения уже нет — тоже успех */
  deleteApp(target: PlatformTarget, appId: string): Promise<void>
}

export const DEPLOYMENT_PLATFORM = Symbol('DEPLOYMENT_PLATFORM')
