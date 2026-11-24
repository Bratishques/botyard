import { AuthService } from '../modules/auth/application/auth.service'
import { AuditLog } from '../shared/audit/audit'
import { loadConfig } from '../shared/config/config'
import { createDb } from '../shared/database/database'
import { UnitOfWork } from '../shared/database/unit-of-work'

/**
 * Завести оператора: `bun run operator:create <email>`, пароль — со stdin (не аргументом:
 * аргументы видны в списке процессов и в истории shell).
 */
const email = process.argv[2]
if (!email) {
  console.error('usage: bun run operator:create <email>   (password is read from stdin)')
  process.exit(2)
}

const password = (await Bun.stdin.text()).replace(/\r?\n$/, '')
const config = loadConfig()
const db = createDb(config.DATABASE_URL, { max: 1 })
const unitOfWork = new UnitOfWork(db)

try {
  const operator = await new AuthService(unitOfWork, new AuditLog(unitOfWork), config).createOperator(email, password)
  console.log(`operator ${operator.email} created: ${operator.id}`)
} catch (error) {
  console.error(`operator is not created: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
} finally {
  await db.destroy()
}
