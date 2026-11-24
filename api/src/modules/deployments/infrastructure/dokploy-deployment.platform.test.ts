import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import createFixture from '../../../../test/fixtures/dokploy/application.create.json'
import notFoundFixture from '../../../../test/fixtures/dokploy/application.not-found.json'
import oneFixture from '../../../../test/fixtures/dokploy/application.one.json'
import searchFixture from '../../../../test/fixtures/dokploy/application.search.json'
import deploymentsFixture from '../../../../test/fixtures/dokploy/deployment.all.json'
import mountFixture from '../../../../test/fixtures/dokploy/mounts.create.json'
import unauthorizedFixture from '../../../../test/fixtures/dokploy/unauthorized.json'
import { DEFAULT_DOKPLOY_CLIENT, DokployClient } from '../../../shared/dokploy/dokploy.client'
import { PlatformError, type PlatformTarget } from '../domain/deployment-platform'
import { DokployDeploymentPlatform } from './dokploy-deployment.platform'

/** Dokploy на Bun.serve, ответы — записанные с живого v0.31.4 (test/fixtures/dokploy/README.md) */
type Reply = { status: number; body?: unknown; delayMs?: number }
const replies = new Map<string, Reply[]>()
const seen: { method: string; query: Record<string, string>; body: unknown }[] = []
let server: ReturnType<typeof Bun.serve>
let target: PlatformTarget

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const url = new URL(request.url)
      const method = url.pathname.replace('/api/', '')
      const body = request.method === 'POST' ? await request.json() : undefined
      seen.push({ method, query: Object.fromEntries(url.searchParams), body })
      const reply = replies.get(method)?.shift() ?? { status: 200, body: true }
      if (reply.delayMs) await Bun.sleep(reply.delayMs)

      return reply.body === undefined ? new Response(null, { status: reply.status }) : Response.json(reply.body, { status: reply.status })
    },
  })
  target = {
    baseUrl: `http://127.0.0.1:${server.port}`,
    apiKey: 'key',
    environmentId: searchFixture.items[0]?.environmentId ?? '',
    serverId: null,
  }
})

afterAll(() => {
  server.stop(true)
})

beforeEach(() => {
  replies.clear()
  seen.length = 0
})

const fastRetry = { ...DEFAULT_DOKPLOY_CLIENT, retry: { ...DEFAULT_DOKPLOY_CLIENT.retry, baseDelayMs: 1, maxDelayMs: 2 } }
const platform = () => new DokployDeploymentPlatform(new DokployClient(fastRetry))
const reply = (method: string, ...list: Reply[]) => replies.set(method, list)
const sent = (method: string) => seen.filter((call) => call.method === method)

async function failure(work: Promise<unknown>): Promise<PlatformError> {
  try {
    await work
  } catch (error) {
    if (error instanceof PlatformError) return error
    throw error
  }
  throw new Error('expected a failure')
}

describe('Dokploy как платформа развёртывания', () => {
  test('поиск: точное имя с хвостом Dokploy и то же окружение; похожие имена и чужие окружения — мимо', async () => {
    const [app] = searchFixture.items
    if (!app) throw new Error('fixture has no items')
    reply('application.search', {
      status: 200,
      body: {
        total: 4,
        items: [
          app,
          { ...app, applicationId: 'other-env', environmentId: 'elsewhere' },
          { ...app, applicationId: 'longer-name', appName: 'by-fixture000012-abc123' },
          { ...app, applicationId: 'prefix-only', appName: 'by-fixture00001x-abc123' },
        ],
      },
    })

    const apps = await platform().findApps(target, 'by-fixture00001')

    expect(apps).toEqual([{ id: app.applicationId, appName: app.appName }])
    expect(sent('application.search')[0]?.query).toEqual({ appName: 'by-fixture00001', environmentId: target.environmentId })
  })

  test('create: id и имя из ответа; env и пароли из ответа до кода не доходят', async () => {
    reply('application.create', { status: 200, body: createFixture })

    const app = await platform().createApp(target, { appName: 'by-fixture00001', name: 'by-fixture00001', description: 'd' })

    expect(app).toEqual({ id: createFixture.applicationId, appName: createFixture.appName })
    expect(JSON.stringify(app)).not.toContain('redacted')
    expect(sent('application.create')[0]?.body).toEqual({
      appName: 'by-fixture00001',
      name: 'by-fixture00001',
      description: 'd',
      environmentId: target.environmentId,
      serverId: null,
    })
  })

  test('configure: источник, сборка, env строками KEY=value и file mount — обновить, создать, лишний удалить', async () => {
    const existing = oneFixture.mounts[0]
    if (!existing) throw new Error('fixture has no mounts')
    reply('application.one', {
      status: 200,
      body: { ...oneFixture, mounts: [existing, { ...existing, mountId: 'stale', mountPath: '/opt/old/config.toml' }] },
    })
    reply('mounts.update', { status: 200, body: mountFixture })
    reply('mounts.create', { status: 200, body: mountFixture })

    await platform().configure(target, 'app-1', {
      source: { gitUrl: 'https://github.com/elkopass/BITA.git', ref: 'main' },
      build: { dockerfile: 'cmd/trade-bot/Dockerfile', context: '.' },
      runtime: {
        env: { A: '1', B: 't.token' },
        files: [
          { mountPath: existing.mountPath, content: 'x = 1' },
          { mountPath: '/etc/ssl/botyard/tinvest-root-ca.pem', content: 'PEM' },
        ],
      },
    })

    expect(sent('application.saveGitProvider')[0]?.body).toMatchObject({
      customGitUrl: 'https://github.com/elkopass/BITA.git',
      customGitBranch: 'main',
    })
    expect(sent('application.saveBuildType')[0]?.body).toMatchObject({ buildType: 'dockerfile', dockerfile: 'cmd/trade-bot/Dockerfile' })
    expect(sent('application.saveEnvironment')[0]?.body).toMatchObject({ env: 'A=1\nB=t.token', createEnvFile: false })
    expect(sent('mounts.update').map((call) => call.body)).toEqual([
      expect.objectContaining({ mountId: existing.mountId, content: 'x = 1', filePath: 'config.toml', mountPath: existing.mountPath }),
    ])
    expect(sent('mounts.create').map((call) => call.body)).toEqual([
      expect.objectContaining({
        serviceId: 'app-1',
        filePath: 'tinvest-root-ca.pem',
        mountPath: '/etc/ssl/botyard/tinvest-root-ca.pem',
        type: 'file',
      }),
    ])
    expect(sent('mounts.remove').map((call) => call.body)).toEqual([{ mountId: 'stale' }])
  })

  test('последний деплой — по времени создания; пусто — null', async () => {
    const [recorded] = deploymentsFixture
    if (!recorded) throw new Error('fixture is empty')
    const older = { ...recorded, deploymentId: 'older', status: 'done', createdAt: '2026-11-24T10:00:00.000Z' }
    reply('deployment.all', { status: 200, body: [older, recorded] }, { status: 200, body: [] })

    expect(await platform().latestDeployment(target, 'app-1')).toEqual({ id: recorded.deploymentId, status: 'error' })
    expect(await platform().latestDeployment(target, 'app-1')).toBeNull()
  })

  test('удаление уже удалённого (404 Service not found) — успех; ключ не принят — отказ без повтора', async () => {
    reply('application.delete', { status: 404, body: notFoundFixture })
    await platform().deleteApp(target, 'gone')

    reply('application.delete', { status: 401, body: unauthorizedFixture })
    const rejected = await failure(platform().deleteApp(target, 'app-1'))
    expect(rejected.retryable).toBe(false)
  })

  test('5xx и таймаут изменения — временная ошибка (исход неизвестен), без повтора внутри клиента', async () => {
    reply('application.deploy', { status: 502, body: { message: 'Bad Gateway' } })
    const error = await failure(platform().deploy(target, 'app-1'))

    expect(error.retryable).toBe(true)
    expect(sent('application.deploy')).toHaveLength(1)
  })

  test('start ждёт дольше обычного: Dokploy отвечает, когда сервис сошёлся', async () => {
    reply('application.start', { status: 200, body: true, delayMs: 11_000 })

    await platform().start(target, 'app-1')

    expect(sent('application.start')).toHaveLength(1)
  }, 20_000)
})
