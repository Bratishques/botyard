import { describe, expect, test } from 'bun:test'
import { DokployClient } from '../../src/shared/dokploy/dokploy.client'
import { DokployUnauthorizedError } from '../../src/shared/dokploy/dokploy.errors'

/**
 * Контракт адаптера с живым Dokploy. Запускается только при заданных DOKPLOY_TEST_URL и
 * DOKPLOY_TEST_API_KEY (`bun run test:contract`), в CI и обычном `bun test` пропускается.
 * Ключ берётся из окружения и никуда не печатается.
 */
const baseUrl = process.env.DOKPLOY_TEST_URL
const apiKey = process.env.DOKPLOY_TEST_API_KEY
const live = describe.skipIf(!baseUrl || !apiKey)

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
