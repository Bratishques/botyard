import { Injectable } from '@nestjs/common'
import { DokployClient } from '../../../shared/dokploy/dokploy.client'
import type { DokployCatalog } from '../domain/ports'

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

  async servers(baseUrl: string, apiKey: string): Promise<{ serverId: string; name: string }[]> {
    const servers = await this.client.listServers({ baseUrl, apiKey })

    return servers.map((server) => ({ serverId: server.serverId, name: server.name }))
  }
}
