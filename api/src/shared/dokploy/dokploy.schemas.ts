import { z } from 'zod'

/**
 * Схемы ответов Dokploy — только поля, которыми пользуется Botyard; остальное отбрасывается.
 *
 * Источник: исходники Dokploy, ветка canary, коммит b1b216e6d47dbc76e52a03d055fac98092b19fcc
 * (apps/dokploy/server/api/routers/project.ts — `all`, routers/server.ts — `all`,
 * packages/server/src/db/schema/{project,environment,server}.ts). OpenAPI Dokploy ответы не описывает,
 * а с живого инстанса они пока не записаны — см. test/fixtures/dokploy/README.md.
 */
export const dokployProjectsSchema = z.array(
  z.object({
    projectId: z.string().min(1),
    name: z.string(),
    environments: z.array(
      z.object({
        environmentId: z.string().min(1),
        name: z.string(),
        isDefault: z.boolean(),
      }),
    ),
  }),
)
export type DokployProject = z.infer<typeof dokployProjectsSchema>[number]

export const dokployServersSchema = z.array(
  z.object({
    serverId: z.string().min(1),
    name: z.string(),
    ipAddress: z.string(),
    serverStatus: z.enum(['active', 'inactive']),
    serverType: z.enum(['deploy', 'build']),
  }),
)
export type DokployServer = z.infer<typeof dokployServersSchema>[number]

/** Тело ошибки REST-слоя Dokploy: `{ message }`, у ошибок процедур бывает ещё `code` */
export const dokployErrorSchema = z.object({ message: z.string().optional(), code: z.string().optional() })
