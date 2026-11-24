# Dokploy для Botyard

Dokploy — назначение, куда Botyard разворачивает роботов. Он ставится на отдельный сервер и
захватывает порты 80, 443 и 3000, а также включает Docker Swarm. Поэтому **не на рабочую машину**:
нужен VPS или локальная виртуальная машина.

## Установка

Минимум для стенда: 2 vCPU, 2–4 ГБ RAM, Ubuntu 24.04, свободные порты 80, 443, 3000.
Сборка двух Go-роботов (golang:1.18) занимает около 1 ГБ места на образы.

```bash
# на сервере
curl -sSL https://dokploy.com/install.sh | sh
```

Затем `http://<ip>:3000` → создать администратора.

Локальная ВМ вместо VPS:

```bash
multipass launch 24.04 --name dokploy --cpus 2 --memory 4G --disk 20G
multipass shell dokploy   # и дальше команда установки выше
```

## Подготовка для Botyard

1. **API-ключ:** Settings → Profile → API/CLI Keys. Ключ даёт полный доступ к инстансу: хранить как секрет.
2. **Проект и окружение:** создать проект `botyard`, взять `environmentId` окружения (`GET /api/project.all`).
3. **Удалённые серверы (по желанию):** Dokploy умеет разворачивать на подключённые по SSH серверы.
   Их `serverId` указывается в назначении Botyard.
4. **Вебхук (этап 3):** Notifications → Custom → URL `https://<api>/webhooks/dokploy`, заголовок
   `x-botyard-signature` с общим секретом, события App Deploy и App Build Error.

Проверка ключа:

```bash
curl -s -H "x-api-key: $DOKPLOY_API_KEY" "$DOKPLOY_URL/api/project.all" | jq '.[].name'
```

## Методы API, которыми пользуется Botyard

Проверено по OpenAPI Dokploy (ветка `canary`, 2026-11-24). Аутентификация — заголовок `x-api-key`.

| Метод | Зачем |
|---|---|
| `GET project.all` | проверка ключа, выбор окружения |
| `GET application.search?appName=` | поиск перед созданием: у `create` нет ключа идемпотентности |
| `POST application.create` | `name`, `appName`, `environmentId`, `serverId?` |
| `POST application.saveGitProvider` | `customGitUrl`, `customGitBranch`, `customGitBuildPath`, `watchPaths` |
| `POST application.saveBuildType` | `buildType: dockerfile`, `dockerfile`, `dockerContextPath`, `dockerBuildStage` |
| `POST application.saveEnvironment` | `env`, `buildArgs`, `buildSecrets`, `createEnvFile` |
| `POST mounts.create` | file mount с конфигом (`type: file`, `content`, `mountPath`, `serviceId`) |
| `POST application.deploy` / `start` / `stop` / `delete` | жизненный цикл |
| `POST application.cancelDeployment` | отмена сборки при удалении |
| `GET application.one` | статус (`idle`, `running`, `done`, `error`) |
| `GET deployment.all` | история деплоев приложения |
| `GET application.readLogs` | логи (`tail`, `since`, `search`) |
| `POST notification.createCustom` | вебхук о деплоях |

Схемы ответов в OpenAPI не описаны: их нужно записать с живого инстанса в контрактные фикстуры api.

## Развёртывание самого api

- Порт метрик (`METRICS_PORT`, по умолчанию 9464) отдаёт `/metrics` без авторизации: его не публиковать
  наружу, только во внутреннюю сеть к Prometheus.
- Миграции запускаются отдельной командой `bun run migrate` до старта новой версии, а не каждой репликой.
