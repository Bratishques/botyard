# Botyard Bots

Каталог торговых роботов T-Invest API, которых Botyard умеет разворачивать. Здесь только манифесты:
код роботов не копируется, Dokploy собирает их из исходных репозиториев.

| Шаблон | Upstream | Язык | Конфиг | Лицензия |
|---|---|---|---|---|
| `bita` | [elkopass/BITA](https://github.com/elkopass/BITA) | Go | переменные окружения | Apache-2.0 |
| `contest-2022` | [Antonboom/tinkoff-invest-robot-contest-2022](https://github.com/Antonboom/tinkoff-invest-robot-contest-2022) | Go | TOML-файл (file mount) | Apache-2.0 |

Два робота выбраны так, чтобы покрыть оба способа доставки конфига: env и файл.

## Манифест

`templates/<id>/template.json`, схема — `schema/template.schema.json`.

- `upstream` — откуда собирать.
- `build` — путь к Dockerfile и контекст сборки.
- `config.schema` — JSON Schema конфига, который оператор заполняет в админке.
- `config.delivery` — как конфиг попадает в контейнер:
  - `env` — карта переменных, значения — шаблоны Handlebars;
  - `file` — шаблон файла и путь монтирования.

Переменные шаблонов: `config.*` — конфиг развёртывания, `customer.*` — клиент (`accountId`, `sandbox`),
`secret.*` — расшифрованные секреты клиента. Секреты подставляются только в момент отправки в Dokploy.

## Добавить робота

1. Убедиться, что у робота есть Dockerfile, а лицензия разрешает использование.
2. Описать манифест и шаблон конфига.
3. Проверить сборку: `docker build -f <dockerfile> <context>` в клоне upstream.
4. Проверить запуск в песочнице T-Invest.

> Стратегии роботов принадлежат их авторам. Botyard не даёт инвестиционных рекомендаций.
> По умолчанию всё запускается в песочнице.
