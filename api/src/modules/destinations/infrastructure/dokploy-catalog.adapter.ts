import { Injectable } from '@nestjs/common'
import { z } from 'zod'
import { DokployClient } from '../../../shared/dokploy/dokploy.client'
import type { DokployCatalog } from '../domain/ports'

/** Максимум `limit` у `application.search` в Dokploy v0.31.4 */
const PAGE = 100
const searchPage = z.object({
  items: z.array(z.object({ applicationId: z.string().min(1), environmentId: z.string() })),
  total: z.number().int().nonnegative(),
})

/** Каталог назначения из Dokploy: окружения всех проектов плоским списком и серверы */
@Injectable()
export class DokployCatalogAdapter implements DokployCatalog {
  constructor(private readonly client: DokployClient) {}

  async environments(baseUrl: string, apiKey: string): Promise<{ projectId: string; environmentId: string; name: string }[]> {
    const projects = await this.client.listProjects({ baseUrl, apiKey })

    return projects.flatMap((project) =>
      project.environments.map((environment) => ({
        projectId: project.projectId,
        environmentId: environment.environmentId,
        name: `${project.name} / ${environment.name}`,
      })),
    )
  }

  async applicationIds(baseUrl: string, apiKey: string, environmentId: string): Promise<Set<string>> {
    const ids = new Set<string>()
    for (let offset = 0; ; offset += PAGE) {
      const page = await this.client.query(
        { baseUrl, apiKey },
        'application.search',
        { environmentId, limit: String(PAGE), offset: String(offset) },
        searchPage,
      )
      for (const app of page.items) if (app.environmentId === environmentId) ids.add(app.applicationId)
      if (page.items.length < PAGE || offset + PAGE >= page.total) return ids
    }
  }

  async servers(baseUrl: string, apiKey: string): Promise<{ serverId: string; name: string }[]> {
    const servers = await this.client.listServers({ baseUrl, apiKey })

    return servers.map((server) => ({ serverId: server.serverId, name: server.name }))
  }
}
