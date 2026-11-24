import { describe, expect, test } from 'bun:test'
import { firstStep, nextStep, OUTCOME, RETRY, retryDelayMs, SAGA, SagaStep } from './saga'

describe('сага', () => {
  test('provision и redeploy — один путь до ожидания деплоя; start, stop, delete — один шаг', () => {
    expect(SAGA.PROVISION).toEqual(['ensure_app', 'configure', 'prepare_deploy', 'deploy', 'await_deploy'])
    expect(SAGA.REDEPLOY).toEqual(SAGA.PROVISION)
    expect([SAGA.START, SAGA.STOP, SAGA.DELETE]).toEqual([['start'], ['stop'], ['delete']])
    expect(firstStep('PROVISION')).toBe(SagaStep.ENSURE_APP)
    expect(nextStep('PROVISION', SagaStep.DEPLOY)).toBe(SagaStep.AWAIT_DEPLOY)
    expect(nextStep('PROVISION', SagaStep.AWAIT_DEPLOY)).toBeNull()
    expect(() => nextStep('STOP', SagaStep.DEPLOY)).toThrow('does not belong')
  })

  test('упавшее удаление оставляет DELETING (можно повторить), прочие отказы — FAILED', () => {
    expect(OUTCOME.DELETE).toEqual({ succeeded: 'DELETED', failed: 'DELETING' })
    expect(OUTCOME.STOP).toEqual({ succeeded: 'STOPPED', failed: 'FAILED' })
  })

  test('пауза повтора: экспонента с jitter под потолком, не меньше Retry-After', () => {
    expect(retryDelayMs(1, () => 1)).toBe(RETRY.baseMs)
    expect(retryDelayMs(3, () => 1)).toBe(RETRY.baseMs * 4)
    expect(retryDelayMs(30, () => 1)).toBe(RETRY.maxDelayMs)
    expect(retryDelayMs(3, () => 0)).toBe(0)
    expect(retryDelayMs(1, () => 0, 42_000)).toBe(42_000)
    // Retry-After длиннее потолка — потолок: иначе reconciler принял бы законную паузу за зависание
    expect(retryDelayMs(1, () => 0, 15 * 60_000)).toBe(RETRY.maxDelayMs)
  })
})
