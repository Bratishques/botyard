# Реестр ошибок агента

Порядок ведения — [error-learning](../../skills/botyard-error-learning/SKILL.md).

## DEP-API-FROM-MEMORY — API зависимости по памяти, а не по установленной версии

- **Подтверждение:** 2026-11-24, `bun run migrate` упал с `Export named 'FileMigrationProvider' not found`:
  в Kysely 0.29 миграции вынесены в отдельный вход `kysely/migration`. Код был написан по API старых версий.
- **Причина:** установились версии новее памяти модели (Kysely 0.29, NestJS 12, TypeScript 7, Biome 2.6),
  а импорт не сверили с `exports` установленного пакета.
- **Правило:** [botyard-prepare](../../skills/botyard-prepare/SKILL.md), раздел 3 — API библиотеки проверять
  по установленному пакету.
- **Проверка:** после исправления импорта миграция применилась, повторный запуск ответил `schema is up to date`.
  Предотвращение проверено только текстом правила.
