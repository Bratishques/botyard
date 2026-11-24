# Фикстуры ответов Dokploy

**Происхождение: выведены из исходников, не записаны с живого инстанса.**

OpenAPI Dokploy описывает только запросы. Формы ответов здесь собраны по исходникам Dokploy
(ветка `canary`, коммит `b1b216e6d47dbc76e52a03d055fac98092b19fcc`):

| Файл               | Источник                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------- |
| `project.all.json` | `apps/dokploy/server/api/routers/project.ts` (`all`, ветка owner/admin), схемы `project`, `environment` |
| `server.all.json`  | `apps/dokploy/server/api/routers/server.ts` (`all`), схема `server`                                     |
| ошибки 401/429     | `apps/dokploy/pages/api/[...trpc].ts`: `401 { message: "Unauthorized" }`, `429` с `Retry-After`         |

Значения (id, имена, даты) выдуманы. Лишние поля оставлены специально: клиент обязан их отбрасывать.

Когда появится живой Dokploy (см. `infra/dokploy/README.md`), ответы записываются заново, очищаются
от ключей и токенов, а эта пометка заменяется версией Dokploy и датой записи.
