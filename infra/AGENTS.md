# AGENTS.md — botyard/infra

Окружение разработки и инструкции по Dokploy.

- Пароли в `docker-compose.dev.yml` только для локальной разработки. Настоящие секреты стенда сюда не попадают:
  только `.env` (в `.gitignore`) и `.env.example` с пустыми значениями.
- Порты dev-окружения сдвинуты (55432, 55672, 55673, 56379): на машине разработчика уже работают свои
  Postgres и Redis.
- Установку Dokploy не запускать на машине разработчика: он забирает 80, 443, 3000 и включает Swarm.
  Только VPS или ВМ.
- Список методов Dokploy в `dokploy/README.md` обновляется вместе с адаптером в api.

## Подготовка, проверка и ревью

Общие навыки лежат в `../api/.agents/skills` и применяются и здесь:
[botyard-prepare](../api/.agents/skills/botyard-prepare/SKILL.md) до правки,
[botyard-verify](../api/.agents/skills/botyard-verify/SKILL.md) с двумя независимыми ревью до отчёта,
[botyard-error-learning](../api/.agents/skills/botyard-error-learning/SKILL.md) при подтверждённой ошибке агента.
Порядок коммитов и завершения задачи — раздел «Git и завершение задачи» в [../api/AGENTS.md](../api/AGENTS.md).
