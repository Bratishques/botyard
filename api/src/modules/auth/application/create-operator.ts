import { AuditLog } from '../../../shared/audit/audit'
import { UnitOfWork } from '../../../shared/database/unit-of-work'
import { AuthError, AuthErrorCode, MIN_PASSWORD_LENGTH, normalizeEmail, type Operator, type OperatorRepository } from '../domain/auth'

/**
 * Завести оператора. Отдельный сценарий без конфига приложения: им пользуется CLI, которому не нужны
 * ни мастер-ключ, ни порты. Вставка и аудит — одна транзакция; повтор той же почты — `OPERATOR_EXISTS`.
 */
export class CreateOperator {
  constructor(
    private readonly operators: OperatorRepository,
    private readonly unitOfWork: UnitOfWork,
    private readonly audit: AuditLog,
  ) {}

  async execute(emailInput: string, password: string, actor: string): Promise<Operator> {
    const email = normalizeEmail(emailInput)
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new AuthError(AuthErrorCode.WEAK_PASSWORD, `password must be at least ${MIN_PASSWORD_LENGTH} characters`)
    }
    const id = Bun.randomUUIDv7()
    const passwordHash = await Bun.password.hash(password, { algorithm: 'argon2id' })

    return this.unitOfWork.run(async () => {
      await this.operators.insert({ id, email, passwordHash })
      await this.audit.record({ actor, action: 'operator.created', targetType: 'operator', targetId: id, payload: { email } })

      return { id, email }
    })
  }
}
