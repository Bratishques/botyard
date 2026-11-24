# Botyard

[![CI](https://github.com/Bratishques/botyard/actions/workflows/ci.yml/badge.svg)](https://github.com/Bratishques/botyard/actions/workflows/ci.yml)

Платформа, которая разворачивает торговых роботов [T-Invest API](https://developer.tbank.ru/invest/intro/intro)
для клиентов на серверах под управлением [Dokploy](https://dokploy.com). Оператор в админке заводит
назначения (Dokploy-инстансы) и клиентов, выбирает робота из каталога — платформа создаёт приложение
в Dokploy, собирает образ из исходников робота, передаёт конфиг и секреты, запускает и следит за состоянием.

*Work in progress. A platform that deploys open-source T-Invest trading bots for customers through
the Dokploy API. Designed: an orchestrated saga over a non-idempotent external API, transactional outbox
with RabbitMQ, race-tested state transitions. Done so far: envelope encryption of customer secrets,
append-only audit enforced by the database, log redaction, the api skeleton with integration tests.
Bun, NestJS, PostgreSQL.*

```
admin ──► api ──► outbox ──► RabbitMQ ──► worker ──► Dokploy ──► контейнер робота ──► T-Invest API (песочница)
                    ▲                                    │
                    └──── reconciler ◄── вебхуки и опрос ┘
```

## Статус

Проект в разработке: этап 1 из 5 ([план](api/docs/roadmap.md)). Дизайн целиком —
в [архитектуре](api/docs/architecture.md): домен, машина состояний, шаги саги, разобранные гонки.

**Уже сделано**

- **Envelope encryption** секретов клиентов: AES-256-GCM, свой ключ данных на каждую запись, AAD привязывает
  шифртекст к записи и к адресу, куда секрет уйдёт; мастер-ключ за портом. Ключевые свойства закреплены
  тестами (уникальный nonce, проверка тегов, привязка к контексту, обрезанные конверты).
- **Append-only аудит**, запрещённый на уровне базы (UPDATE, DELETE, TRUNCATE), CHECK-ограничения на инварианты.
- **Маскирование секретов в логах** по имени поля и виду значения на любой глубине.
- Каркас api: конфиг с проверкой при старте, JSON-логи, health live/ready, метрики Prometheus на отдельном порту,
  миграции, интеграционные тесты на настоящем Postgres, CI.

**Спроектировано, реализуется по плану**

- **Сага поверх неидемпотентного API.** У `application.create` в Dokploy нет ключа идемпотентности:
  имя приложения выводится из id развёртывания, и перед созданием сага ищет приложение по нему — потерянный
  ответ не создаёт второе. Таймаут считается неизвестным исходом, а не отказом.
- **Transactional outbox → RabbitMQ**, inbox для вебхуков, reconciler для зависших операций и дрейфа.
- **Условные переходы состояний** и тесты гонок: двойной деплой, стоп против провижининга, вебхук против опроса.

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
