import { CreateOperator } from '../modules/auth/application/create-operator'
import { AuthError } from '../modules/auth/domain/auth'
import { PostgresOperatorRepository } from '../modules/auth/infrastructure/postgres-auth.repositories'
import { AuditLog } from '../shared/audit/audit'
import { loadDatabaseConfig } from '../shared/config/config'
import { createDb } from '../shared/database/database'
import { UnitOfWork } from '../shared/database/unit-of-work'

/**
 * Завести оператора: `echo "$PASSWORD" | bun run operator:create <email>`.
 *
 * Пароль — только со stdin и только не с терминала: аргументы видны в списке процессов и истории
 * shell, а ввод с терминала печатается на экране. Нужна только база — мастер-ключ и прочий конфиг
 * приложения команде не нужны.
 */
const email = process.argv[2]
if (!email) {
  console.error('usage: echo "$PASSWORD" | bun run operator:create <email>')
  process.exit(2)
}
if (process.stdin.isTTY) {
  console.error('refusing to read the password from a terminal: pipe it, e.g. `read -rs P; echo "$P" | bun run operator:create <email>`')
  process.exit(2)
}

// Снимаются все завершающие переводы строки: `echo` и heredoc добавляют свой
const password = (await Bun.stdin.text()).replace(/[\r\n]+$/, '')
const db = createDb(loadDatabaseConfig().DATABASE_URL, { max: 1 })
const unitOfWork = new UnitOfWork(db)

try {
  const createOperator = new CreateOperator(new PostgresOperatorRepository(unitOfWork), unitOfWork, new AuditLog(unitOfWork))
  const operator = await createOperator.execute(email, password, 'system:cli')
  console.log(`operator ${operator.email} created: ${operator.id}`)
} catch (error) {
  if (!(error instanceof AuthError)) console.error(error)
  console.error(`operator is not created: ${error instanceof AuthError ? `${error.code}: ${error.message}` : 'unexpected error'}`)
  process.exitCode = 1
} finally {
  await db.destroy()
}
