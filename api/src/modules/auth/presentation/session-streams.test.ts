import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { HttpException } from '@nestjs/common'
import type { Request, Response } from 'express'
import type { AuthService } from '../application/auth.service'
import type { Operator } from '../domain/auth'
import { SESSION_COOKIE } from './session.guard'
import { SessionStreams, STREAMS_PER_OPERATOR } from './session-streams'

const operator: Operator = { id: 'op-1', email: 'op@example.com' }

function connection() {
  const request = Object.assign(new EventEmitter(), { destroyed: false, headers: { cookie: `${SESSION_COOKIE}=tok` } })
  let ended = false
  const response = Object.assign(new EventEmitter(), {
    writableEnded: false,
    destroyed: false,
    writableLength: 0,
    status: () => response,
    setHeader: () => response,
    flushHeaders: () => undefined,
    write: () => true,
    end: () => {
      ended = true
    },
  })
  return { request: request as unknown as Request, response: response as unknown as Response, ended: () => ended }
}

function streams(resolve: () => Promise<Operator | null>) {
  const service = new SessionStreams({ resolve } as unknown as AuthService)
  service.recheckMs = 5
  return service
}

describe('потоки под сессией', () => {
  test('сверх предела — 429 до открытия потока; закрытый поток освобождает место', () => {
    const service = streams(async () => operator)
    const open = Array.from({ length: STREAMS_PER_OPERATOR.logs }, () =>
      service.start(connection().request, connection().response, operator, 'logs'),
    )

    const extra = connection()
    let error: unknown
    try {
      service.start(extra.request, extra.response, operator, 'logs')
    } catch (caught) {
      error = caught
    }
    expect((error as HttpException).getStatus()).toBe(429)
    // Другой вид потоков и другой оператор считаются отдельно
    expect(() => service.start(connection().request, connection().response, operator, 'events')).not.toThrow()
    expect(() => service.start(connection().request, connection().response, { ...operator, id: 'op-2' }, 'logs')).not.toThrow()

    open[0]?.close()
    expect(() => service.start(connection().request, connection().response, operator, 'logs')).not.toThrow()
    for (const stream of open) stream.close()
  })

  test('сессия кончилась (выход, отзыв) — открытый поток закрывается при перепроверке; сбой базы поток не рвёт', async () => {
    let session: 'active' | 'broken' | 'gone' = 'broken'
    const service = streams(async () => {
      if (session === 'broken') throw new Error('db down')
      return session === 'active' ? operator : null
    })
    const live = connection()
    service.start(live.request, live.response, operator, 'events')

    await Bun.sleep(20)
    expect(live.ended()).toBe(false)
    session = 'gone'
    await Bun.sleep(20)
    expect(live.ended()).toBe(true)
  })
})
