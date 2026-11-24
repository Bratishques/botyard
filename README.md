# Botyard

[![CI](https://github.com/Bratishques/botyard/actions/workflows/ci.yml/badge.svg)](https://github.com/Bratishques/botyard/actions/workflows/ci.yml)

Платформа, которая разворачивает торговых роботов [T-Invest API](https://developer.tbank.ru/invest/intro/intro)
для клиентов на серверах под управлением [Dokploy](https://dokploy.com). Оператор в админке заводит
назначения (Dokploy-инстансы) и клиентов, выбирает робота из каталога — платформа создаёт приложение
в Dokploy, собирает образ из исходников робота, передаёт конфиг и секреты, запускает и следит за состоянием.

*Work in progress. A platform that deploys open-source T-Invest trading bots for customers through
the Dokploy API. Designed: an orchestrated saga over a non-idempotent external API, transactional outbox
with RabbitMQ, race-tested state transitions. Done so far: Dokploy destinations with a client verified
against a live Dokploy, operator sign-in with throttling, envelope encryption of customer secrets,
append-only audit enforced by the database, log redaction, integration and race tests.
Bun, NestJS, PostgreSQL.*

```
admin ──► api ──► outbox ──► RabbitMQ ──► worker ──► Dokploy ──► контейнер робота ──► T-Invest API (песочница)
                    ▲                                    │
                    └──── reconciler ◄── вебхуки и опрос ┘
```

## Статус

Проект в разработке: этап 2 из 5 ([план](api/docs/roadmap.md)). Дизайн целиком —
в [архитектуре](api/docs/architecture.md): домен, машина состояний, шаги саги, разобранные гонки.

**Уже сделано**

- **Сага поверх неидемпотентного API Dokploy.** Воркер разворачивает, запускает, останавливает и удаляет
  роботов. У `application.create` нет ключа идемпотентности: сага ищет приложение по имени из id развёртывания
  перед созданием, а потерянный ответ на `deploy` распознаёт по списку деплоев. Шаг арендуется условной
  записью, повторная доставка из RabbitMQ его не дублирует, ожидание деплоя живёт в outbox, а не в памяти.
  Особенности API проверены на живом Dokploy, BITA развёрнута сквозным прогоном. Reconciler будит операции с
  пропавшей командой, а безнадёжные закрывает, чтобы оператор не застрял.
- **Transactional outbox → RabbitMQ:** `FOR UPDATE SKIP LOCKED`, подтверждения брокера, `mandatory`,
  отложенная публикация, выход процесса при потере брокера.
- **Развёртывания и операции:** `Idempotency-Key`, одна активная операция, режим торговли закреплён за роботом,
  тесты гонок с принудительным переплетением (создание против архивации, выключения назначения, синхронизации
  каталога; дубль шага во время аренды; опоздавший воркер).
- **Каталог роботов** с неизменными версиями и проверкой шаблонов конфига; рендер с экранированием под env и
  TOML. Роботам передаётся корень сертификатов T-Invest (Минцифры), без которого Go в alpine не проверит TLS;
  робот, не проверяющий сертификат, допускается только в песочницу.
- **Клиенты:** токен T-Invest привязан к режиму (песочный не откроется как боевой), боевой режим — с
  подтверждением; токен и счёт проверяются у T-Invest (боевой — открытый счёт с полным доступом).
- **Envelope encryption** секретов: AES-256-GCM, свой ключ данных на каждую запись, AAD привязывает
  шифртекст к записи и к адресу, куда секрет уйдёт; мастер-ключ за портом.
- **Append-only аудит**, запрещённый на уровне базы (UPDATE, DELETE, TRUNCATE), CHECK-ограничения на инварианты.
- **Маскирование секретов в логах** по имени поля и виду значения на любой глубине.
- **Назначения** Dokploy с проверкой ключа и окружения; **вход операторов** (argon2id, сессии в базе, CSRF).
- **Админка операторов** (React, TanStack): назначения, клиенты, каталог, развёртывания с формой конфига по JSON
  Schema шаблона и историей операций; `Idempotency-Key` на попытку пользователя, ошибки по коду, без секретов в браузере.
- Каркас api: конфиг с проверкой при старте, JSON-логи, health, метрики Prometheus, миграции, CI.

**Дальше по плану**

- Вебхуки Dokploy с inbox, логи роботов, живой статус в админке по SSE, демо-стенд.

## Структура

| Папка | Что внутри |
|---|---|
| [api](api) | бэкенд: NestJS 12 на Bun, Kysely + PostgreSQL 17, RabbitMQ; дизайн-документы в `api/docs` |
| [packages/contract](packages/contract) | контракт админ-API: схемы запросов (zod) и формы ответов — общие для api и админки |
| [admin](admin) | админка для операторов: React 19, Vite, TanStack Router и Query, Tailwind; форма конфига робота по JSON Schema |
| [bots](bots) | каталог роботов: манифесты для [BITA](https://github.com/elkopass/BITA) и [Contest Robot 2022](https://github.com/Antonboom/tinkoff-invest-robot-contest-2022) |
| [infra](infra) | dev-окружение (Postgres, RabbitMQ, Redis) и установка Dokploy |

Монорепо на [Turborepo](https://turborepo.com) и workspaces Bun: зависимости ставятся один раз в корне, версии общих
инструментов (`zod`, TypeScript, Biome) — в каталоге корневого `package.json`, задачи идут по графу пакетов с кешем.

## Запуск

Нужны [Bun](https://bun.sh) ≥ 1.4 и Docker.

```bash
docker compose -f infra/docker-compose.dev.yml up -d --wait
bun install                                            # в корне: все пакеты
cp api/.env.example api/.env                           # и задать SECRETS_MASTER_KEY: openssl rand -base64 32
cd api && bun run migrate && bun run dev               # http://localhost:4000/health/ready
cd .. && bun run check && bun run test:int             # линтер, типы и тесты всех пакетов через turbo
cd admin && bun run dev                                # админка: http://localhost:5173, API через прокси /api
```

Оператор для входа в админку — `bun run operator:create` в `api`.

## Дисклеймер

Роботы — сторонние open-source проекты, по умолчанию работают в песочнице T-Invest. Botyard не даёт
инвестиционных рекомендаций и не отвечает за стратегии роботов.

## Лицензия

[MIT](LICENSE)
