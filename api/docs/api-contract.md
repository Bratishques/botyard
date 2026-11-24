# Контракт админ-API

Документ для репозитория `admin`: всё, что ему нужно знать об API, без чтения кода бэкенда.
Меняется в той же правке, что и API. Изменения — в журнал внизу.

## Общее

- Базовый адрес — `http://localhost:4000` в разработке.
- Тела запросов и ответов — JSON, поля в `camelCase`, время — ISO 8601 в UTC.
- Ошибка: HTTP-статус и тело `{ "code": "<КОД>", "message": "<текст для логов>" }`. Админка показывает
  текст по `code`, а не `message`.
- Изменяющие запросы (`POST`, `PATCH`) — только `Content-Type: application/json`, иначе `415 JSON_REQUIRED`.
  Вместе с cookie `SameSite=Strict` это защита от CSRF; CORS api не открывает, админка ходит с того же origin.
- Всё, кроме `/health/*`, `/auth/login` и `/auth/logout`, требует сессии: без неё `401 UNAUTHENTICATED`.
- `Idempotency-Key` появится на этапе 2 вместе с развёртываниями. Назначения от дублей защищают
  уникальность имени и пары «окружение Dokploy + сервер» (`409`) и правка по `version`.
- Ошибка проверки тела или параметра — `400 VALIDATION_FAILED` с путями полей, без значений (в теле бывают
  секреты). Тело — не JSON — `400 INVALID_JSON` без текста парсера.
- `409` на повтор после обрыва может означать, что первый запрос прошёл: перечитать состояние, а не повторять.
- Секреты (API-ключ Dokploy, токен T-Invest) принимаются только на запись и в ответах не возвращаются;
  вместо них — `apiKeyHint` (последние символы).

## Служебные

| Метод | Путь | Ответ |
|---|---|---|
| GET | `/health/live` | `200 { "status": "ok" }` |
| GET | `/health/ready` | `200 { "status": "ok", "checks": { "postgres": "ok" } }` или `503` с `failed` |

## Вход

| Метод | Путь | Тело | Ответ |
|---|---|---|---|
| POST | `/auth/login` | `{ email, password }` | `200 { id, email }` + cookie `botyard_session` (HttpOnly, SameSite=Strict, Secure в проде); `401 INVALID_CREDENTIALS` — одинаково для неверного пароля и неизвестной почты; `429 LOGIN_THROTTLED` с `Retry-After` — слишком много неудач по почте или IP; `503 LOGIN_BUSY` — перегрузка, повторить |
| POST | `/auth/logout` | `{}` | `204` всегда (и с истёкшей сессией), cookie очищается, сессия отозвана сразу |
| GET | `/auth/me` | — | `200 { id, email }` или `401` |

## Назначения

Назначение в ответах (`Destination`):

```json
{
  "id": "uuid", "name": "prod", "baseUrl": "https://dokploy.example.com", "apiKeyHint": "••••abcd",
  "projectId": "…", "environmentId": "…", "serverId": null,
  "status": "ACTIVE | UNREACHABLE | DISABLED", "lastCheckedAt": null, "lastError": null,
  "version": 1, "createdAt": "…", "updatedAt": "…"
}
```

Ключ Dokploy в ответах не возвращается никогда; принимается ключ от 16 символов. Удаления нет: назначение
выключается (`disable`) — на него будут ссылаться развёртывания. Правка выключенного назначения его не включает.

| Метод | Путь | Тело | Ответ |
|---|---|---|---|
| GET | `/destinations` | — | `200 Destination[]` |
| GET | `/destinations/:id` | — | `200 Destination`, `404 DESTINATION_NOT_FOUND` |
| POST | `/destinations/preview` | `{ baseUrl, apiKey }` | `200 { baseUrl, environments: [{ projectId, environmentId, name }], servers: [{ serverId, name }] }` — для выбора окружения до сохранения |
| POST | `/destinations` | `{ name, baseUrl, apiKey, environmentId, serverId? }` | `201 Destination` |
| PATCH | `/destinations/:id` | `{ version, name?, baseUrl?, apiKey?, environmentId?, serverId? }` | `200 Destination`; смена `baseUrl` требует `apiKey` |
| POST | `/destinations/:id/check` | `{}` | `200 Destination` с результатом проверки связи |
| POST | `/destinations/:id/disable` | `{ version }` | `200 Destination` |
| POST | `/destinations/:id/enable` | `{ version }` | `200 Destination` |

Коды ошибок назначений:

| Код | HTTP | Когда |
|---|---|---|
| `DESTINATION_NOT_FOUND` | 404 | нет такого назначения |
| `DESTINATION_NAME_TAKEN`, `DESTINATION_TARGET_TAKEN` | 409 | имя или то же окружение Dokploy уже заведены |
| `DESTINATION_VERSION_CONFLICT` | 409 | назначение изменили — перечитать и повторить |
| `DESTINATION_INVALID_URL`, `DESTINATION_INVALID_NAME`, `DESTINATION_INSECURE_URL` | 400 | адрес не URL / имя пустое или длиннее 80 / `http` без разрешения |
| `DESTINATION_KEY_REQUIRED` | 400 | смена адреса без нового ключа |
| `DESTINATION_KEY_REJECTED` | 422 | Dokploy не принял ключ |
| `DESTINATION_ENVIRONMENT_NOT_FOUND`, `DESTINATION_SERVER_NOT_FOUND` | 422 | нет такого окружения или сервера в Dokploy |
| `DESTINATION_UNREACHABLE` | 503 | Dokploy недоступен или ответил непонятно |
| `DESTINATION_RATE_LIMITED` | 503 | ключ Dokploy исчерпал свой лимит — выпустить ключ без лимита |

## Журнал

- 2026-11-24 — служебные ручки health.
- 2026-11-24 — вход операторов, назначения, единый формат ошибок `{ code, message }`, 404 без пути запроса.
- 2026-11-24 — лимит входов (`429 LOGIN_THROTTLED`, `503 LOGIN_BUSY`), публичный выход, `INVALID_JSON`, ключ от 16 символов.
