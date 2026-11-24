import path from 'node:path'
import { Injectable } from '@nestjs/common'
import { z } from 'zod'
import { DokployClient, type DokployTarget } from '../../../shared/dokploy/dokploy.client'
import {
  DokployError,
  DokployRateLimitedError,
  DokployRejectedError,
  DokployUnavailableError,
} from '../../../shared/dokploy/dokploy.errors'
import {
  type AppSpec,
  type DeploymentPlatform,
  type PlatformApp,
  type PlatformDeployment,
  PlatformError,
  type PlatformTarget,
} from '../domain/deployment-platform'

/**
 * Схемы ответов — только нужные поля. Ответы приложений Dokploy содержат env, пароли и содержимое файлов
 * вместе с токеном клиента: zod отбрасывает всё, что не описано, и до кода оно не доходит.
 * Формы сверены с живым Dokploy v0.31.4 (test/fixtures/dokploy/README.md).
 */
const appSchema = z.object({ applicationId: z.string().min(1), appName: z.string(), environmentId: z.string() })
const searchSchema = z.object({ items: z.array(appSchema) })
const mountsSchema = z.object({
  mounts: z.array(z.object({ mountId: z.string().min(1), type: z.string(), mountPath: z.string() })),
})
const appStatusSchema = z.object({ applicationStatus: z.string() })
const deploymentsSchema = z.array(z.object({ deploymentId: z.string().min(1), status: z.string(), createdAt: z.string() }))

/**
 * `application.start` выполняет `docker service scale` и ждёт, пока сервис сойдётся: у падающего робота
 * вызов не возвращается. Таймаут ограничивает ожидание; исход тогда неизвестен, и решает сага.
 */
const START_TIMEOUT_MS = 30_000
const STOP_TIMEOUT_MS = 30_000

/**
 * Платформа развёртывания поверх Dokploy. Особенности API, проверенные на живом инстансе:
 *
 * - `application.create` дописывает к `appName` случайный хвост (`by-0123456789ab` → `by-0123456789ab-gz6yu7`);
 * - `application.search?appName=` ищет подстрокой (ILIKE) — точное совпадение проверяется здесь:
 *   то же окружение и имя `<appName>` или `<appName>-<хвост>`;
 * - `application.deploy` только ставит деплой в очередь, исход — в `deployment.all` (новые первыми);
 * - file mount требует `filePath`, хотя OpenAPI его обязательным не помечает;
 * - удаление несуществующего приложения — 404 «Service not found».
 */
@Injectable()
export class DokployDeploymentPlatform implements DeploymentPlatform {
  constructor(private readonly dokploy: DokployClient) {}

  async findApps(target: PlatformTarget, appName: string): Promise<PlatformApp[]> {
    const found = await call('application.search', () =>
      this.dokploy.query(connection(target), 'application.search', { appName, environmentId: target.environmentId }, searchSchema),
    )

    return found.items
      .filter((app) => app.environmentId === target.environmentId && (app.appName === appName || isSuffixed(app.appName, appName)))
      .map((app) => ({ id: app.applicationId, appName: app.appName }))
  }

  async createApp(target: PlatformTarget, app: { appName: string; name: string; description: string }): Promise<PlatformApp> {
    const created = await call('application.create', () =>
      this.dokploy.mutate(
        connection(target),
        'application.create',
        { ...app, environmentId: target.environmentId, serverId: target.serverId },
        appSchema,
      ),
    )

    return { id: created.applicationId, appName: created.appName }
  }

  async configure(target: PlatformTarget, appId: string, spec: AppSpec): Promise<void> {
    const to = connection(target)
    await call('application.saveGitProvider', () =>
      this.dokploy.command(to, 'application.saveGitProvider', {
        applicationId: appId,
        customGitUrl: spec.source.gitUrl,
        customGitBranch: spec.source.ref,
        customGitBuildPath: '/',
        watchPaths: null,
        enableSubmodules: false,
      }),
    )
    await call('application.saveBuildType', () =>
      this.dokploy.command(to, 'application.saveBuildType', {
        applicationId: appId,
        buildType: 'dockerfile',
        dockerfile: spec.build.dockerfile,
        dockerContextPath: spec.build.context,
        dockerBuildStage: null,
        herokuVersion: null,
        railpackVersion: null,
      }),
    )
    await call('application.saveEnvironment', () =>
      this.dokploy.command(to, 'application.saveEnvironment', {
        applicationId: appId,
        env: envFile(spec.runtime.env),
        buildArgs: null,
        buildSecrets: null,
        createEnvFile: false,
      }),
    )
    await this.syncFiles(to, appId, spec.runtime.files)
  }

  async latestDeployment(target: PlatformTarget, appId: string): Promise<PlatformDeployment | null> {
    const deployments = await call('deployment.all', () =>
      this.dokploy.query(connection(target), 'deployment.all', { applicationId: appId }, deploymentsSchema),
    )
    // Dokploy отдаёт новые первыми; сортировка здесь — чтобы не зависеть от этого
    const [latest] = [...deployments].sort((a, b) => b.createdAt.localeCompare(a.createdAt))

    return latest ? { id: latest.deploymentId, status: latest.status } : null
  }

  async deploy(target: PlatformTarget, appId: string): Promise<void> {
    await call('application.deploy', () => this.dokploy.command(connection(target), 'application.deploy', { applicationId: appId }))
  }

  async start(target: PlatformTarget, appId: string): Promise<void> {
    await call('application.start', () =>
      this.dokploy.command(
        connection(target),
        'application.start',
        { applicationId: appId },
        { timeoutMs: START_TIMEOUT_MS, timeoutIsNotFailure: true },
      ),
    )
  }

  async stop(target: PlatformTarget, appId: string): Promise<void> {
    await call('application.stop', () =>
      this.dokploy.command(connection(target), 'application.stop', { applicationId: appId }, { timeoutMs: STOP_TIMEOUT_MS }),
    )
  }

  async deleteApp(target: PlatformTarget, appId: string): Promise<void> {
    try {
      await this.dokploy.command(connection(target), 'application.delete', { applicationId: appId })
    } catch (error) {
      // Только ответ Dokploy «приложения нет». 404 бывает и у Traefik перед ним (Dokploy перезапускается) —
      // такой ответ не повод считать робота удалённым
      if (error instanceof DokployRejectedError && error.status === 404 && error.message.endsWith('404 Service not found')) return
      throw toPlatformError('application.delete', error)
    }
  }

  async readLogs(target: PlatformTarget, appId: string, options: { tail: number; sinceSeconds?: number }): Promise<string> {
    return call('application.readLogs', () =>
      this.dokploy.query(
        connection(target),
        'application.readLogs',
        {
          applicationId: appId,
          tail: String(options.tail),
          ...(options.sinceSeconds !== undefined && { since: `${Math.max(1, Math.ceil(options.sinceSeconds))}s` }),
        },
        z.string(),
      ),
    )
  }

  async appStatus(target: PlatformTarget, appId: string): Promise<string> {
    try {
      const app = await this.dokploy.query(connection(target), 'application.one', { applicationId: appId }, appStatusSchema)
      return app.applicationStatus
    } catch (error) {
      if (error instanceof DokployRejectedError && error.status === 404 && error.message.endsWith('404 Service not found')) return 'missing'
      throw toPlatformError('application.one', error)
    }
  }

  /**
   * Файлы робота — file mount'ы, сверка по `mountPath`: есть — перезаписать, нет — создать, лишний файл
   * (шаблон сменил путь) или второй на тот же путь — удалить, чтобы старый конфиг с токеном не остался.
   */
  private async syncFiles(to: DokployTarget, appId: string, files: AppSpec['runtime']['files']): Promise<void> {
    const current = await call('application.one', () => this.dokploy.query(to, 'application.one', { applicationId: appId }, mountsSchema))
    const existing = new Map<string, string>()
    const duplicates: string[] = []
    for (const mount of current.mounts.filter((candidate) => candidate.type === 'file')) {
      // Два mount'а на один путь — след шага, выполненного дважды: лишний удаляется, в нём мог остаться старый токен
      if (existing.has(mount.mountPath)) duplicates.push(mount.mountId)
      else existing.set(mount.mountPath, mount.mountId)
    }

    for (const file of files) {
      const body = {
        type: 'file',
        content: file.content,
        filePath: path.posix.basename(file.mountPath),
        mountPath: file.mountPath,
        serviceType: 'application',
      }
      const mountId = existing.get(file.mountPath)
      if (mountId) await call('mounts.update', () => this.dokploy.command(to, 'mounts.update', { ...body, mountId }))
      else await call('mounts.create', () => this.dokploy.command(to, 'mounts.create', { ...body, serviceId: appId }))
      existing.delete(file.mountPath)
    }
    for (const mountId of [...existing.values(), ...duplicates]) {
      await call('mounts.remove', () => this.dokploy.command(to, 'mounts.remove', { mountId }))
    }
  }
}

function connection(target: PlatformTarget): DokployTarget {
  return { baseUrl: target.baseUrl, apiKey: target.apiKey }
}

/** Имя, которое Dokploy дал приложению по нашему `appName`: `<appName>-<хвост из [a-z0-9]>` */
function isSuffixed(actual: string, appName: string): boolean {
  return actual.startsWith(`${appName}-`) && /^[a-z0-9]+$/.test(actual.slice(appName.length + 1))
}

/**
 * Env-файл Dokploy: строки `KEY=value`. Значения уже проверены рендером (без переводов строк и спецсимволов
 * dotenv), здесь — только склейка.
 */
function envFile(env: Readonly<Record<string, string>>): string {
  return Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')
}

async function call<T>(method: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    throw toPlatformError(method, error)
  }
}

/** Недоступность и лимит — временно (исход неизвестен); прочие ответы Dokploy и ошибки кода — отказ */
function toPlatformError(method: string, error: unknown): Error {
  if (error instanceof DokployUnavailableError || error instanceof DokployRateLimitedError) {
    return new PlatformError(true, error.message, error.retryAfterMs, { cause: error })
  }
  if (error instanceof DokployError) return new PlatformError(false, error.message, undefined, { cause: error })

  // Не ответ Dokploy и не сеть (их клиент уже различил) — ошибка в коде: повтор её не исправит
  return new PlatformError(false, `${method}: ${error instanceof Error ? error.message : 'failed'}`, undefined, { cause: error })
}
