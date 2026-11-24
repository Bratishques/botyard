import { describe, expect, test } from 'bun:test'
import { ServiceUnavailableException } from '@nestjs/common'
import type { ReadinessCheck } from '../domain/readiness-check'
import { HealthController } from './health.controller'

const check = (name: string, fails: boolean): ReadinessCheck => ({
  name,
  probe: async () => {
    if (fails) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
  },
})

describe('HealthController.ready', () => {
  test('все проверки прошли — ok с перечнем', async () => {
    const controller = new HealthController([check('postgres', false)])

    expect(await controller.ready()).toEqual({ status: 'ok', checks: { postgres: 'ok' } })
  })

  test('упавшая проверка — 503 с её именем', async () => {
    const controller = new HealthController([check('postgres', true), check('redis', false)])

    const error = await controller.ready().catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ServiceUnavailableException)
    expect((error as ServiceUnavailableException).getResponse()).toEqual({ status: 'fail', failed: ['postgres'] })
  })
})
