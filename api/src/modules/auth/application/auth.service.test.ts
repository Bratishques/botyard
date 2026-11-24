import { describe, expect, test } from 'bun:test'
import type { AuditLog } from '../../../shared/audit/audit'
import { loadConfig } from '../../../shared/config/config'
import type { UnitOfWork } from '../../../shared/database/unit-of-work'
import type { LoginThrottle, OperatorRecord, OperatorRepository, SessionRepository } from '../domain/auth'
import { AuthService } from './auth.service'

const config = loadConfig({ DATABASE_URL: 'postgres://u:p@localhost:5432/db', SECRETS_MASTER_KEY: Buffer.alloc(32).toString('base64') })
const password = 'correct horse battery staple'
const passwordHash = await Bun.password.hash(password, { algorithm: 'argon2id' })

/** Ограничитель-шпион: записывает вызовы, лимит не применяет */
class SpyThrottle implements LoginThrottle {
  readonly calls: string[] = []
  tryAcquire(keys: readonly string[]): number | null {
    this.calls.push(`acquire ${keys.join(' ')}`)
    return null
  }
  forgive(keys: readonly string[]): void {
    this.calls.push(`forgive ${keys.join(' ')}`)
  }
  reset(keys: readonly string[]): void {
    this.calls.push(`reset ${keys.join(' ')}`)
  }
}

function service(operators: OperatorRepository, throttle: LoginThrottle): AuthService {
  const sessions: SessionRepository = { create: async () => {}, findActive: async () => null, revoke: async () => null }
  const unitOfWork = { run: <T>(work: () => Promise<T>) => work() } as unknown as UnitOfWork
  const audit = { record: async () => {} } as unknown as AuditLog

  return new AuthService(operators, sessions, throttle, config, unitOfWork, audit)
}

const record: OperatorRecord = { id: 'op-1', email: 'op@botyard.local', passwordHash }

describe('AuthService.login и ограничитель', () => {
  test('сбой хранилища до проверки пароля снимает резерв: это не попытка угадать пароль', async () => {
    const throttle = new SpyThrottle()
    const broken: OperatorRepository = {
      findByEmail: async () => {
        throw new Error('db is down')
      },
      insert: async () => {},
    }

    await expect(service(broken, throttle).login('op@botyard.local', password, '10.0.0.1')).rejects.toThrow('db is down')
    expect(throttle.calls).toEqual(['acquire email:op@botyard.local ip:10.0.0.1', 'forgive email:op@botyard.local ip:10.0.0.1'])
  })

  test('успешный вход снимает свой резерв и сбрасывает неудачи почты', async () => {
    const throttle = new SpyThrottle()
    const operators: OperatorRepository = { findByEmail: async () => record, insert: async () => {} }

    await service(operators, throttle).login('op@botyard.local', password, '10.0.0.1')
    expect(throttle.calls).toEqual([
      'acquire email:op@botyard.local ip:10.0.0.1',
      'forgive email:op@botyard.local ip:10.0.0.1',
      'reset email:op@botyard.local',
    ])
  })

  test('неверный пароль резерв не снимает: он остаётся засчитанной неудачей', async () => {
    const throttle = new SpyThrottle()
    const operators: OperatorRepository = { findByEmail: async () => record, insert: async () => {} }

    await expect(service(operators, throttle).login('op@botyard.local', 'wrong', '10.0.0.1')).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
    })
    expect(throttle.calls).toEqual(['acquire email:op@botyard.local ip:10.0.0.1'])
  })
})
