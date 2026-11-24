# AGENTS.md — botyard/admin

Админка операторов Botyard: назначения, клиенты, развёртывания, логи, аудит.
Работает только с админ-API из `../api`; контракты описаны в `../api/docs/architecture.md`.

## Стек

Bun (пакеты, скрипты, тесты), React 19, Vite, TypeScript strict, TanStack Router и Query, формы — react-hook-form + zod.
Каркас генерируется на этапе 4 (см. `../api/docs/roadmap.md`).

## Правила

- Админка не хранит секретов: токен T-Invest и API-ключ Dokploy уходят в API один раз при сохранении и
  обратно приходят только маской.
- Каждое изменяющее действие отправляет `Idempotency-Key` (UUID на попытку пользователя, а не на HTTP-запрос):
  повтор после обрыва не создаёт вторую операцию.
- Статус развёртывания приходит по SSE. Оптимистичных переходов статуса нет: показывается то, что
  подтвердил сервер.
- Включение боевого режима (`sandbox = false`) — отдельное подтверждение с вводом имени клиента.
- Ошибка API показывается по коду (`OPERATION_IN_PROGRESS`, `DESTINATION_UNREACHABLE`), а не сырым текстом.

## Подготовка, проверка и ревью

Общие навыки лежат в `../api/.agents/skills` и применяются и здесь:
[botyard-prepare](../api/.agents/skills/botyard-prepare/SKILL.md) до правки,
[botyard-verify](../api/.agents/skills/botyard-verify/SKILL.md) с двумя независимыми ревью до отчёта,
[botyard-error-learning](../api/.agents/skills/botyard-error-learning/SKILL.md) при подтверждённой ошибке агента.
Порядок коммитов и завершения задачи — раздел «Git и завершение задачи» в [../api/AGENTS.md](../api/AGENTS.md).
