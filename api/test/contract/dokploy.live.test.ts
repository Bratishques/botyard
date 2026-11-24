import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { DokployDeploymentPlatform } from '../../src/modules/deployments/infrastructure/dokploy-deployment.platform'
import { DokployClient } from '../../src/shared/dokploy/dokploy.client'
import { DokployUnauthorizedError } from '../../src/shared/dokploy/dokploy.errors'

/**
 * Контракт адаптера с живым Dokploy. Запускается только при заданных DOKPLOY_TEST_URL и
 * DOKPLOY_TEST_API_KEY (`bun run test:contract`), в CI и обычном `bun test` пропускается.
 * Ключ берётся из окружения и никуда не печатается.
 */
const baseUrl = process.env.DOKPLOY_TEST_URL
const apiKey = process.env.DOKPLOY_TEST_API_KEY
/** Окружение, в котором контракт создаёт и удаляет пробное приложение (не боевое!) */
const environmentId = process.env.DOKPLOY_TEST_ENVIRONMENT_ID
const live = describe.skipIf(!baseUrl || !apiKey)
const liveApps = describe.skipIf(!baseUrl || !apiKey || !environmentId)

live('Dokploy (живой инстанс)', () => {
  const client = new DokployClient()
  const target = () => ({ baseUrl: baseUrl ?? '', apiKey: apiKey ?? '' })

  test('project.all разбирается схемой адаптера', async () => {
    const projects = await client.listProjects(target())

    expect(Array.isArray(projects)).toBe(true)
    for (const project of projects) expect(project.environments.length).toBeGreaterThan(0)
  })

  test('server.all разбирается схемой адаптера', async () => {
    expect(Array.isArray(await client.listServers(target()))).toBe(true)
  })

  test('неверный ключ — DokployUnauthorizedError', async () => {
    await expect(client.listProjects({ baseUrl: baseUrl ?? '', apiKey: 'definitely-not-a-key' })).rejects.toBeInstanceOf(
      DokployUnauthorizedError,
    )
  })
})

liveApps('Dokploy как платформа развёртывания (живой инстанс, пробное приложение)', () => {
  const platform = new DokployDeploymentPlatform(new DokployClient())
  const target = () => ({ baseUrl: baseUrl ?? '', apiKey: apiKey ?? '', environmentId: environmentId ?? '', serverId: null })

  test('create дописывает хвост, поиск находит своё, configure с file mount, повторное удаление — не ошибка', async () => {
    const appName = `by-${crypto.randomUUID().replace(/-/g, '').slice(-12)}`
    const created = await platform.createApp(target(), { appName, name: appName, description: 'Botyard contract test' })
    try {
      expect(created.appName.startsWith(`${appName}-`)).toBe(true)
      expect(await platform.findApps(target(), appName)).toEqual([created])
      expect(await platform.findApps(target(), appName.slice(0, -1))).toEqual([])

      const spec = {
        source: { gitUrl: 'https://github.com/elkopass/BITA.git', ref: 'main' },
        build: { dockerfile: 'cmd/trade-bot/Dockerfile', context: '.' },
        runtime: { env: { A: '1' }, files: [{ mountPath: '/opt/contract/config.toml', content: 'a = 1' }] },
      }
      await platform.configure(target(), created.id, spec)
      // Второй раз — обновление того же mount, а не второй
      await platform.configure(target(), created.id, spec)
      const mounts = await new DokployClient().query(
        target(),
        'application.one',
        { applicationId: created.id },
        z.object({ mounts: z.array(z.object({ mountPath: z.string() })) }),
      )
      expect(mounts.mounts.map((mount) => mount.mountPath)).toEqual(['/opt/contract/config.toml'])
      expect(await platform.latestDeployment(target(), created.id)).toBeNull()
    } finally {
      await platform.deleteApp(target(), created.id)
    }
    await platform.deleteApp(target(), created.id)
    expect(await platform.findApps(target(), appName)).toEqual([])
  }, 60_000)
})
