# Botyard

[![CI](https://github.com/Bratishques/botyard/actions/workflows/ci.yml/badge.svg)](https://github.com/Bratishques/botyard/actions/workflows/ci.yml)

Платформа, которая разворачивает торговых роботов [T-Invest API](https://developer.tbank.ru/invest/intro/intro)
для клиентов на серверах под управлением [Dokploy](https://dokploy.com). Оператор в админке заводит
назначения (Dokploy-инстансы) и клиентов, выбирает робота из каталога — платформа создаёт приложение
в Dokploy, собирает образ из исходников робота, передаёт конфиг и секреты, запускает и следит за состоянием.

*A platform that deploys open-source T-Invest trading bots for customers through the Dokploy API:
orchestrated saga over a non-idempotent external API, transactional outbox with RabbitMQ, conditional
state transitions with race tests, envelope encryption of customer secrets. Bun, NestJS, PostgreSQL.*

```
admin ──► api ──► outbox ──► RabbitMQ ──► worker ──► Dokploy ──► контейнер робота ──► T-Invest API (песочница)
                    ▲                                    │
                    └──── reconciler ◄── вебхуки и опрос ┘
```

## Что здесь интересного

- **Сага поверх неидемпотентного API.** У `application.create` в Dokploy нет ключа идемпотентности:
  имя приложения выводится из id развёртывания, и перед созданием сага ищет приложение по нему — потерянный
  ответ не создаёт второе. Таймаут считается неизвестным исходом, а не отказом.
- **Transactional outbox → RabbitMQ**, inbox для вебхуков, reconciler для зависших операций и дрейфа.
- **Условные переходы состояний** и тесты гонок: двойной деплой, стоп против провижининга, вебхук против опроса.
- **Envelope encryption** токенов клиентов: AES-256-GCM, ключ данных на запись, AAD привязывает шифртекст
  к строке, мастер-ключ за портом (локальный ключ или KMS).
- **Append-only аудит**, запрещённый на уровне базы, маскирование секретов в логах на любой глубине.

Подробно — [архитектура](api/docs/architecture.md): домен, машина состояний, шаги саги, разобранные гонки.

## Статус

Этап 1 из 5 ([план](api/docs/roadmap.md)): каркас api, конфиг, логи, health, метрики, миграции,
шифрование секретов, интеграционные тесты. Дальше — адаптер Dokploy и назначения, затем сага.

## Структура

| Папка | Что внутри |
|---|---|
| [api](api) | бэкенд: NestJS 12 на Bun, Kysely + PostgreSQL 17, RabbitMQ; дизайн-документы в `api/docs` |
| [admin](admin) | админка для операторов (React, Vite) — этап 4 |
| [bots](bots) | каталог роботов: манифесты для [BITA](https://github.com/elkopass/BITA) и [Contest Robot 2022](https://github.com/Antonboom/tinkoff-invest-robot-contest-2022) |
| [infra](infra) | dev-окружение (Postgres, RabbitMQ, Redis) и установка Dokploy |

## Запуск

Нужны [Bun](https://bun.sh) ≥ 1.4 и Docker.

```bash
docker compose -f infra/docker-compose.dev.yml up -d --wait
cd api
cp .env.example .env                                   # и задать SECRETS_MASTER_KEY: openssl rand -base64 32
bun install
bun run migrate
bun run dev                                            # http://localhost:4000/health/ready
bun run check && bun run test:int                      # линтер, типы, unit и интеграционные тесты
```

## Дисклеймер

Роботы — сторонние open-source проекты, по умолчанию работают в песочнице T-Invest. Botyard не даёт
инвестиционных рекомендаций и не отвечает за стратегии роботов.

## Лицензия

[MIT](LICENSE)
