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
- `Idempotency-Key` (8–128 символов `A-Z a-z 0-9 - _`) обязателен для изменяющих запросов к развёртываниям:
  повтор с тем же ключом и телом возвращает прежний успешный ответ с прежним кодом (тот же JSON, порядок ключей
  может отличаться), тот же ключ с другим телом — `409 IDEMPOTENCY_CONFLICT`, без ключа —
  `400 IDEMPOTENCY_KEY_REQUIRED`. Ошибки не сохраняются: повтор после ошибки выполняется заново. Все операции
  над одним развёртыванием делят пространство ключей: тот же ключ для `stop` и `start` — 409. Ключ — на одну попытку пользователя
  (генерировать при открытии формы, а не на каждый HTTP-запрос). Назначения и клиенты от дублей защищают
  уникальность и правка по `version`.
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

## Каталог роботов

| Метод | Путь | Ответ |
|---|---|---|
| GET | `/templates` | `200 Template[]` — действующие шаблоны |
| GET | `/templates/:id` | `200 Template` — в том числе выведенный (`retired: true`): на него ссылаются развёрнутые роботы; `404 CATALOG_TEMPLATE_NOT_FOUND` |

`Template`: `{ id, name, description, currentVersion, retired, delivery: "env" | "file", configSchema, upstream: { gitUrl, ref, license } }`.
`configSchema` — JSON Schema (draft 2020-12) конфига робота: по ней админка строит форму развёртывания.

## Клиенты

`Customer`: `{ id, name, accountId, tokenHint, mode: "sandbox" | "live", status: "ACTIVE" | "ARCHIVED", version, createdAt, updatedAt }`.
Токен T-Invest в ответах не возвращается; принимается токен от 16 символов. Клиент создаётся в песочнице.

| Метод | Путь | Тело | Ответ |
|---|---|---|---|
| GET | `/customers` | — | `200 Customer[]` |
| GET | `/customers/:id` | — | `200 Customer`, `404 CUSTOMER_NOT_FOUND` |
| POST | `/customers` | `{ name, accountId, token }` | `201 Customer`; токен и счёт проверяются в песочнице T-Invest |
| PATCH | `/customers/:id` | `{ version, name?, accountId?, confirmName? }` | `200 Customer`; смена счёта клиента в боевом режиме — только с `confirmName` (точное имя), иначе `422 CUSTOMER_LIVE_CONFIRMATION_REQUIRED` |
| POST | `/customers/:id/token` | `{ version, token }` | `200 Customer` — новый токен того же режима |
| POST | `/customers/:id/live` | `{ version, token, accountId, confirmName }` | `200 Customer`; боевой токен и боевой счёт (счета песочницы и боевые разные); `confirmName` — точное имя клиента, иначе `422 CUSTOMER_LIVE_CONFIRMATION_REQUIRED` |
| POST | `/customers/:id/sandbox` | `{ version, token, accountId }` | `200 Customer` — назад в песочницу с токеном и счётом песочницы |
| POST | `/customers/:id/archive` | `{ version }` | `200 Customer`; повтор после обрыва с прежней версией — тот же клиент без изменений. Разархивации нет, имя архивного клиента остаётся занятым |

Коды: `CUSTOMER_NOT_FOUND` (404); `CUSTOMER_NAME_TAKEN`, `CUSTOMER_VERSION_CONFLICT`, `CUSTOMER_ALREADY_IN_MODE`,
`CUSTOMER_ARCHIVED` (409); `CUSTOMER_INVALID_NAME`, `CUSTOMER_INVALID_ACCOUNT` (400); `CUSTOMER_LIVE_CONFIRMATION_REQUIRED` (422).

Токен и счёт проверяются у T-Invest при создании, ротации токена, смене режима и смене счёта (в режиме клиента):
`CUSTOMER_TOKEN_REJECTED` (токен не принят), `CUSTOMER_ACCOUNT_NOT_FOUND` (у токена нет такого открытого счёта),
`CUSTOMER_TOKEN_READ_ONLY` (боевой токен «только чтение»), `CUSTOMER_ACCOUNT_NOT_TRADABLE` (не брокерский счёт и не ИИС),
`CUSTOMER_LIVE_TOKEN_IN_SANDBOX` (для песочницы дан токен с полным доступом к реальному счёту) — 422;
`CUSTOMER_BROKER_UNAVAILABLE` — 503, повторить позже; `CUSTOMER_LIVE_CHECK_DISABLED` — 409, проверка выключена
конфигурацией: боевой режим, ротация токена и смена счёта боевого клиента недоступны. Токен — печатные ASCII без
пробелов, иначе `400 VALIDATION_FAILED`.

## Развёртывания

`Deployment`: `{ id, customerId, destinationId, templateId, templateVersion, config, tradingMode, appName, status, activeOperationId,
lastError, version, createdAt, updatedAt }`; статусы `PROVISIONING | RUNNING | STOPPED | FAILED | DELETING | DELETED`;
`tradingMode` — `sandbox | live`, режим клиента на момент создания.
`Operation`: `{ id, kind: PROVISION | START | STOP | REDEPLOY | DELETE, status: PENDING | RUNNING | SUCCEEDED | FAILED, step,
attempt, error, requestedBy, createdAt, finishedAt }`; `step` — текущий шаг саги (`ensure_app`, `configure`,
`prepare_deploy`, `deploy`, `await_deploy`, `start`, `stop`, `delete`), `attempt` — попытка этого шага,
`error` — причина отказа без секретов. Операции выполняет воркер саги; ответ на запрос —
принятая операция, а не её результат.

| Метод | Путь | Тело | Ответ |
|---|---|---|---|
| GET | `/deployments` | — | `200 Deployment[]` |
| GET | `/deployments/:id` | — | `200 Deployment & { operations: Operation[] }` |
| POST | `/deployments` | `{ customerId, destinationId, templateId, config }` + `Idempotency-Key` | `201 Deployment & { operation }`; конфиг проверяется по `configSchema` текущей версии шаблона, `default` подставляются |
| POST | `/deployments/:id/start` | `{ version }` + `Idempotency-Key` | `202 Deployment & { operation }` — из `STOPPED`; назначение не выключено |
| POST | `/deployments/:id/stop` | то же | `202` — из `RUNNING` и `FAILED` |
| POST | `/deployments/:id/redeploy` | то же | `202` — из `RUNNING`, `STOPPED`, `FAILED`; назначение не выключено |
| POST | `/deployments/:id/delete` | то же | `202`, статус `DELETING` — из любого, кроме `DELETED`; из `DELETING` — повтор упавшего удаления |

Другое действие в пути — `404 NOT_FOUND`.

Коды: `DEPLOYMENT_NOT_FOUND` (404); `DEPLOYMENT_OPERATION_IN_PROGRESS` (идёт другая операция — дождаться),
`DEPLOYMENT_INVALID_STATE`, `DEPLOYMENT_VERSION_CONFLICT`, `IDEMPOTENCY_CONFLICT` (409); `DEPLOYMENT_INVALID_CONFIG`
(пути полей без значений), `DEPLOYMENT_CUSTOMER_UNAVAILABLE`, `DEPLOYMENT_DESTINATION_UNAVAILABLE`,
`DEPLOYMENT_TEMPLATE_UNAVAILABLE`, `DEPLOYMENT_TEMPLATE_NOT_LIVE_SAFE` (робот не проверяет сертификат T-Invest,
а клиент боевой) (422); `IDEMPOTENCY_KEY_REQUIRED` (400). Start и redeploy на выключенном назначении —
`422 DEPLOYMENT_DESTINATION_UNAVAILABLE`.

Клиента с неудалёнными развёртываниями нельзя архивировать и переключать между песочницей и боевым режимом:
`409 CUSTOMER_HAS_DEPLOYMENTS`.

## Журнал

- 2026-11-24 — служебные ручки health.
- 2026-11-24 — вход операторов, назначения, единый формат ошибок `{ code, message }`, 404 без пути запроса.
- 2026-11-24 — лимит входов (`429 LOGIN_THROTTLED`, `503 LOGIN_BUSY`), публичный выход, `INVALID_JSON`, ключ от 16 символов.
- 2026-11-24 — каталог роботов и клиенты.
- 2026-11-24 — счёт обязателен при смене режима, смена счёта боевого клиента — с подтверждением.
- 2026-11-24 — развёртывания и операции, `Idempotency-Key`, `CUSTOMER_HAS_DEPLOYMENTS`, `tradingMode`, запрет смены
  режима клиента с роботами, start/redeploy на выключенном назначении — 422, повтор удаления из `DELETING`.
- 2026-11-24 — воркер саги: `step` операции, stop из `FAILED`, `DEPLOYMENT_TEMPLATE_NOT_LIVE_SAFE`;
  назначение с роботами: `DESTINATION_HAS_DEPLOYMENTS`, `DESTINATION_KEY_CANNOT_SEE_DEPLOYMENTS`.
- 2026-11-24 — проверка токена и счёта у T-Invest: `CUSTOMER_TOKEN_REJECTED`, `CUSTOMER_ACCOUNT_NOT_FOUND`,
  `CUSTOMER_TOKEN_READ_ONLY`, `CUSTOMER_ACCOUNT_NOT_TRADABLE`, `CUSTOMER_LIVE_TOKEN_IN_SANDBOX`,
  `CUSTOMER_BROKER_UNAVAILABLE`, `CUSTOMER_LIVE_CHECK_DISABLED`; токен — печатные ASCII без пробелов.
