/** Оператор админки. Пароль в домене не живёт — только его хеш в хранилище */
export interface Operator {
  readonly id: string
  readonly email: string
}

export const AuthErrorCode = {
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  LOGIN_THROTTLED: 'LOGIN_THROTTLED',
  LOGIN_BUSY: 'LOGIN_BUSY',
  OPERATOR_EXISTS: 'OPERATOR_EXISTS',
  WEAK_PASSWORD: 'WEAK_PASSWORD',
  INVALID_EMAIL: 'INVALID_EMAIL',
} as const
export type AuthErrorCode = (typeof AuthErrorCode)[keyof typeof AuthErrorCode]

export class AuthError extends Error {
  override readonly name = 'AuthError'

  constructor(
    readonly code: AuthErrorCode,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message)
  }
}

export const MIN_PASSWORD_LENGTH = 12

export function normalizeEmail(input: string): string {
  const email = input.trim().toLowerCase()
  if (!/^[^@\s]+@[^@\s]+$/.test(email) || email.length > 254) throw new AuthError(AuthErrorCode.INVALID_EMAIL, 'email is invalid')

  return email
}

export interface OperatorRecord extends Operator {
  readonly passwordHash: string
}

/** Хранилище операторов */
export interface OperatorRepository {
  findByEmail(email: string): Promise<OperatorRecord | null>
  /** Почта уже занята — `AuthError(OPERATOR_EXISTS)` */
  insert(operator: OperatorRecord): Promise<void>
}

export const OPERATOR_REPOSITORY = Symbol('OPERATOR_REPOSITORY')

/** Сессии. В хранилище — только SHA-256 токена */
export interface SessionRepository {
  create(tokenHash: Uint8Array, operatorId: string, expiresAt: Date): Promise<void>
  /** Оператор живой (не отозванной и не истёкшей на момент `now`) сессии */
  findActive(tokenHash: Uint8Array, now: Date): Promise<Operator | null>
  /** Отзыв; id оператора — если сессия была живой и отозвана этим вызовом */
  revoke(tokenHash: Uint8Array, now: Date): Promise<string | null>
}

export const SESSION_REPOSITORY = Symbol('SESSION_REPOSITORY')

/**
 * Ограничение входов по почте и IP. Попытка резервируется до проверки пароля одним шагом (проверка и
 * учёт вместе), иначе параллельный залп прошёл бы мимо лимита, пока первые запросы ждут argon2.
 */
export interface LoginThrottle {
  /** Зарезервировать попытку для всех ключей; если хоть один исчерпал лимит — пауза, и ничего не резервируется */
  tryAcquire(keys: readonly string[], now: number): number | null
  /** Снять резерв удачной попытки: счёт остаётся только неудачам */
  forgive(keys: readonly string[]): void
  /** Забыть ключи целиком: успешный вход обнуляет неудачи своей почты */
  reset(keys: readonly string[]): void
}

export const LOGIN_THROTTLE = Symbol('LOGIN_THROTTLE')
