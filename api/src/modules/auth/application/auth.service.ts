import { createHash, randomBytes } from 'node:crypto'
import { Inject, Injectable } from '@nestjs/common'
import { AuditLog } from '../../../shared/audit/audit'
import { APP_CONFIG, type AppConfig } from '../../../shared/config/config'
import { UnitOfWork } from '../../../shared/database/unit-of-work'

export interface Operator {
  readonly id: string
  readonly email: string
}

export class InvalidCredentialsError extends Error {
  override readonly name = 'InvalidCredentialsError'
}

/** Хеш-приманка: неизвестная почта проверяется так же долго, как известная (не раскрываем, есть ли оператор) */
const DECOY_HASH = await Bun.password.hash('botyard-decoy-password', { algorithm: 'argon2id' })

export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token).digest()
}

/**
 * Вход операторов. Сессия — случайный токен 256 бит в cookie; в базе — только его SHA-256.
 *
 * Гонки: сессия проверяется по базе на каждом запросе, кеша нет — отзыв действует сразу и не может
 * быть «воскрешён» значением, прочитанным до отзыва. Выход и истечение — условие в том же запросе,
 * которым guard находит сессию.
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly audit: AuditLog,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async createOperator(emailInput: string, password: string): Promise<Operator> {
    const email = emailInput.trim().toLowerCase()
    if (password.length < 12) throw new Error('password must be at least 12 characters')
    const id = Bun.randomUUIDv7()
    const passwordHash = await Bun.password.hash(password, { algorithm: 'argon2id' })

    return this.unitOfWork.run(async () => {
      await this.unitOfWork.db().insertInto('operator').values({ id, email, password_hash: passwordHash }).execute()
      await this.audit.record({ actor: 'system:cli', action: 'operator.created', targetType: 'operator', targetId: id, payload: { email } })

      return { id, email }
    })
  }

  async login(emailInput: string, password: string): Promise<{ token: string; operator: Operator; expiresAt: Date }> {
    const email = emailInput.trim().toLowerCase()
    const row = await this.unitOfWork
      .db()
      .selectFrom('operator')
      .select(['id', 'email', 'password_hash'])
      .where('email', '=', email)
      .executeTakeFirst()

    const valid = await Bun.password.verify(password, row?.password_hash ?? DECOY_HASH)
    if (!row || !valid) {
      await this.audit.record({
        actor: 'anonymous',
        action: 'operator.login_failed',
        targetType: 'operator',
        targetId: row?.id ?? null,
        payload: { email },
      })
      throw new InvalidCredentialsError('invalid email or password')
    }

    const token = randomBytes(32).toString('base64url')
    const expiresAt = new Date(Date.now() + this.config.SESSION_TTL_HOURS * 3_600_000)
    await this.unitOfWork.run(async () => {
      await this.unitOfWork
        .db()
        .insertInto('operator_session')
        .values({ token_hash: hashToken(token), operator_id: row.id, expires_at: expiresAt })
        .execute()
      await this.audit.record({ actor: `operator:${row.id}`, action: 'operator.logged_in', targetType: 'operator', targetId: row.id })
    })

    return { token, operator: { id: row.id, email: row.email }, expiresAt }
  }

  /** Оператор по токену сессии — только для живой, не отозванной и не истёкшей сессии */
  async resolve(token: string): Promise<Operator | null> {
    const row = await this.unitOfWork
      .db()
      .selectFrom('operator_session')
      .innerJoin('operator', 'operator.id', 'operator_session.operator_id')
      .select(['operator.id', 'operator.email'])
      .where('operator_session.token_hash', '=', hashToken(token))
      .where('operator_session.revoked_at', 'is', null)
      .where('operator_session.expires_at', '>', new Date())
      .executeTakeFirst()

    return row ?? null
  }

  async logout(token: string): Promise<void> {
    await this.unitOfWork.run(async () => {
      const revoked = await this.unitOfWork
        .db()
        .updateTable('operator_session')
        .set({ revoked_at: new Date() })
        .where('token_hash', '=', hashToken(token))
        .where('revoked_at', 'is', null)
        .returning('operator_id')
        .executeTakeFirst()
      if (revoked) {
        await this.audit.record({
          actor: `operator:${revoked.operator_id}`,
          action: 'operator.logged_out',
          targetType: 'operator',
          targetId: revoked.operator_id,
        })
      }
    })
  }
}
