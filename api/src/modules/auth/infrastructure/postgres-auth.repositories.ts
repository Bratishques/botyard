import { Injectable } from '@nestjs/common'
import { isUniqueViolation } from '../../../shared/database/pg-errors'
import { UnitOfWork } from '../../../shared/database/unit-of-work'
import {
  AuthError,
  AuthErrorCode,
  type Operator,
  type OperatorRecord,
  type OperatorRepository,
  type SessionRepository,
} from '../domain/auth'

@Injectable()
export class PostgresOperatorRepository implements OperatorRepository {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  async findByEmail(email: string): Promise<OperatorRecord | null> {
    const row = await this.unitOfWork
      .db()
      .selectFrom('operator')
      .select(['id', 'email', 'password_hash'])
      .where('email', '=', email)
      .executeTakeFirst()

    return row ? { id: row.id, email: row.email, passwordHash: row.password_hash } : null
  }

  async insert(operator: OperatorRecord): Promise<void> {
    try {
      await this.unitOfWork
        .db()
        .insertInto('operator')
        .values({ id: operator.id, email: operator.email, password_hash: operator.passwordHash })
        .execute()
    } catch (error) {
      if (isUniqueViolation(error)) throw new AuthError(AuthErrorCode.OPERATOR_EXISTS, `operator ${operator.email} already exists`)
      throw error
    }
  }
}

@Injectable()
export class PostgresSessionRepository implements SessionRepository {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  async create(tokenHash: Uint8Array, operatorId: string, expiresAt: Date): Promise<void> {
    await this.unitOfWork
      .db()
      .insertInto('operator_session')
      .values({ token_hash: tokenHash, operator_id: operatorId, expires_at: expiresAt })
      .execute()
  }

  async findActive(tokenHash: Uint8Array, now: Date): Promise<Operator | null> {
    const row = await this.unitOfWork
      .db()
      .selectFrom('operator_session')
      .innerJoin('operator', 'operator.id', 'operator_session.operator_id')
      .select(['operator.id', 'operator.email'])
      .where('operator_session.token_hash', '=', tokenHash)
      .where('operator_session.revoked_at', 'is', null)
      .where('operator_session.expires_at', '>', now)
      .executeTakeFirst()

    return row ?? null
  }

  async revoke(tokenHash: Uint8Array, now: Date): Promise<string | null> {
    const row = await this.unitOfWork
      .db()
      .updateTable('operator_session')
      .set({ revoked_at: now })
      .where('token_hash', '=', tokenHash)
      .where('revoked_at', 'is', null)
      .returning('operator_id')
      .executeTakeFirst()

    return row?.operator_id ?? null
  }
}
