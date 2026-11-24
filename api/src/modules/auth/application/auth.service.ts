import { createHash, randomBytes } from 'node:crypto'
import { Inject, Injectable } from '@nestjs/common'
import { AuditLog } from '../../../shared/audit/audit'
import { APP_CONFIG, type AppConfig } from '../../../shared/config/config'
import { UnitOfWork } from '../../../shared/database/unit-of-work'
import { loginFailures } from '../../../shared/observability/metrics'
import {
  AuthError,
  AuthErrorCode,
  LOGIN_THROTTLE,
  type LoginThrottle,
  normalizeEmail,
  OPERATOR_REPOSITORY,
  type Operator,
  type OperatorRepository,
  SESSION_REPOSITORY,
  type SessionRepository,
} from '../domain/auth'

/** Хеш-приманка: неизвестная почта проверяется так же долго, как известная (не раскрываем, есть ли оператор) */
const DECOY_HASH = await Bun.password.hash('botyard-decoy-password', { algorithm: 'argon2id' })

/** Одновременных проверок argon2 — не больше стольких; остальные ждут в ограниченной очереди */
const MAX_CONCURRENT_HASHES = 4
const MAX_WAITING_HASHES = 32

export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token).digest()
}

/**
 * Вход операторов. Сессия — случайный токен 256 бит в cookie; в хранилище — только его SHA-256.
 *
 * Модель угроз входа (docs/architecture.md): перебор паролей ограничен по почте и IP до хеширования,
 * argon2 не запускается больше `MAX_CONCURRENT_HASHES` раз одновременно, неизвестная почта неотличима
 * по ответу и времени. Сессия проверяется по базе на каждом запросе, кеша нет: отзыв действует сразу.
 */
@Injectable()
export class AuthService {
  private activeHashes = 0
  private readonly waiting: (() => void)[] = []

  constructor(
    @Inject(OPERATOR_REPOSITORY) private readonly operators: OperatorRepository,
    @Inject(SESSION_REPOSITORY) private readonly sessions: SessionRepository,
    @Inject(LOGIN_THROTTLE) private readonly throttle: LoginThrottle,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly unitOfWork: UnitOfWork,
    private readonly audit: AuditLog,
  ) {}

  async login(emailInput: string, password: string, ip: string): Promise<{ token: string; operator: Operator; expiresAt: Date }> {
    let email: string
    try {
      email = normalizeEmail(emailInput)
    } catch {
      loginFailures.inc({ reason: 'unknown_email' })
      throw invalidCredentials()
    }

    const keys = [`email:${email}`, `ip:${ip}`]
    // Резерв попытки до проверки пароля, одним синхронным шагом: залп не обгоняет лимит
    const blockedFor = this.throttle.tryAcquire(keys, Date.now())
    if (blockedFor !== null) {
      loginFailures.inc({ reason: 'throttled' })
      throw new AuthError(AuthErrorCode.LOGIN_THROTTLED, 'too many failed sign-in attempts', blockedFor)
    }

    let record: Awaited<ReturnType<OperatorRepository['findByEmail']>>
    let valid: boolean
    try {
      record = await this.operators.findByEmail(email)
      valid = await this.withHashSlot(() => Bun.password.verify(password, record?.passwordHash ?? DECOY_HASH))
    } catch (error) {
      // Перегрузка или сбой — не попытка угадать пароль: резерв снимается
      this.throttle.forgive(keys)
      throw error
    }
    if (!record || !valid) {
      loginFailures.inc({ reason: record ? 'wrong_password' : 'unknown_email' })
      // Аудит — только для существующего оператора: строки о выдуманных почтах в неудаляемом журнале не нужны
      if (record) {
        await this.audit.record({
          actor: 'anonymous',
          action: 'operator.login_failed',
          targetType: 'operator',
          targetId: record.id,
          payload: { ip },
        })
      }
      throw invalidCredentials()
    }

    this.throttle.forgive(keys)
    this.throttle.reset([`email:${email}`])
    const token = randomBytes(32).toString('base64url')
    const expiresAt = new Date(Date.now() + this.config.SESSION_TTL_HOURS * 3_600_000)
    await this.unitOfWork.run(async () => {
      await this.sessions.create(hashToken(token), record.id, expiresAt)
      await this.audit.record({
        actor: `operator:${record.id}`,
        action: 'operator.logged_in',
        targetType: 'operator',
        targetId: record.id,
        payload: { ip },
      })
    })

    return { token, operator: { id: record.id, email: record.email }, expiresAt }
  }

  resolve(token: string): Promise<Operator | null> {
    return this.sessions.findActive(hashToken(token), new Date())
  }

  async logout(token: string): Promise<void> {
    await this.unitOfWork.run(async () => {
      const operatorId = await this.sessions.revoke(hashToken(token), new Date())
      if (operatorId) {
        await this.audit.record({
          actor: `operator:${operatorId}`,
          action: 'operator.logged_out',
          targetType: 'operator',
          targetId: operatorId,
        })
      }
    })
  }

  /** Семафор на argon2: сотня параллельных входов не съедает память и CPU, лишние сразу получают отказ */
  private async withHashSlot<T>(work: () => Promise<T>): Promise<T> {
    if (this.activeHashes >= MAX_CONCURRENT_HASHES) {
      if (this.waiting.length >= MAX_WAITING_HASHES) {
        loginFailures.inc({ reason: 'busy' })
        throw new AuthError(AuthErrorCode.LOGIN_BUSY, 'sign-in is busy, retry shortly', 1_000)
      }
      await new Promise<void>((resolve) => this.waiting.push(resolve))
    } else {
      this.activeHashes++
    }

    try {
      return await work()
    } finally {
      const next = this.waiting.shift()
      if (next) next()
      else this.activeHashes--
    }
  }
}

function invalidCredentials(): AuthError {
  return new AuthError(AuthErrorCode.INVALID_CREDENTIALS, 'invalid email or password')
}
