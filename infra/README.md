# Botyard Infra

- `docker-compose.dev.yml` — Postgres 17, RabbitMQ 4, Redis 7 для разработки api.
- `dokploy/` — как поднять Dokploy-назначение и подготовить его для Botyard.

```bash
docker compose -f docker-compose.dev.yml up -d --wait
```

База `botyard_test` создаётся скриптом `postgres/init` только при первой инициализации тома.
Если том создан раньше: `docker compose -f docker-compose.dev.yml down -v` (dev-данные удалятся).

| Сервис | Адрес | Логин |
|---|---|---|
| Postgres | `postgres://botyard:botyard@localhost:55432/botyard`, тестовая база `botyard_test` | — |
| RabbitMQ | `amqp://botyard:botyard@localhost:55672`, UI `http://localhost:55673` | botyard / botyard |
| Redis | `redis://localhost:56379` | — |

RabbitMQ 4 не разрешает временные неэксклюзивные очереди — очереди Botyard устойчивые (`durable`).
Интеграционные тесты ходят в vhost `botyard_test` (создаётся при старте брокера), dev-процессы — в `/`.
