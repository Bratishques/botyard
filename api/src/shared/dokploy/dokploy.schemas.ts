import { z } from 'zod'

/**
 * Схемы ответов Dokploy — только поля, которыми пользуется Botyard; остальное отбрасывается и не
 * проверяется: новое значение в неиспользуемом поле не должно ронять разбор.
 *
 * OpenAPI Dokploy ответы не описывает. `project.all` сверен с живым Dokploy v0.31.4, `server.all` —
 * с исходниками; происхождение каждой фикстуры — test/fixtures/dokploy/README.md.
 */
export const dokployProjectsSchema = z.array(
  z.object({
    projectId: z.string().min(1),
    name: z.string(),
    environments: z.array(
      z.object({
        environmentId: z.string().min(1),
        name: z.string(),
      }),
    ),
  }),
)
export type DokployProject = z.infer<typeof dokployProjectsSchema>[number]

export const dokployServersSchema = z.array(
  z.object({
    serverId: z.string().min(1),
    name: z.string(),
  }),
)
export type DokployServer = z.infer<typeof dokployServersSchema>[number]

/** Тело ошибки REST-слоя Dokploy: `{ message }`, у ошибок процедур бывает ещё `code` */
export const dokployErrorSchema = z.object({ message: z.string().optional(), code: z.string().optional() })
