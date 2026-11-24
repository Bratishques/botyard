import { HttpException, HttpStatus, Injectable } from '@nestjs/common'
import type { Request, Response } from 'express'
import { openSse, type SseStream } from '../../../shared/http/sse'
import { AuthService } from '../application/auth.service'
import type { Operator } from '../domain/auth'
import { readCookie, SESSION_COOKIE } from './session.guard'

/** Как часто открытый поток перепроверяет сессию: выход или истечение закрывают поток не позже чем через это время */
export const STREAM_SESSION_RECHECK_MS = 30_000

/** Потоков одного вида на оператора в процессе: вкладки админки плюс запас; больше — уже утечка или перебор */
export const STREAMS_PER_OPERATOR: Readonly<Record<StreamKind, number>> = { events: 5, logs: 3 }

export type StreamKind = 'events' | 'logs'

/**
 * SSE под сессией оператора. Guard проверяет сессию один раз — при открытии, а поток живёт часами: без
 * перепроверки выход из админки или отзыв сессии не закрывали бы уже открытые потоки. Счётчик — в процессе:
 * общий предел по всем репликам не нужен, нужен предел, который не даёт одной вкладке съесть процесс.
 */
@Injectable()
export class SessionStreams {
  private readonly open = new Map<string, number>()
  recheckMs = STREAM_SESSION_RECHECK_MS

  constructor(private readonly auth: AuthService) {}

  /** Открыть поток; предел исчерпан — 429 до открытия (обычный JSON-ответ, а не поток) */
  start(request: Request, response: Response, operator: Operator, kind: StreamKind): SseStream {
    const key = `${kind}:${operator.id}`
    const count = this.open.get(key) ?? 0
    if (count >= STREAMS_PER_OPERATOR[kind]) {
      throw new HttpException({ code: 'TOO_MANY_STREAMS', message: `too many ${kind} streams` }, HttpStatus.TOO_MANY_REQUESTS)
    }
    // Счёт — до открытия и синхронно: параллельные запросы не проскочат между проверкой и учётом
    this.open.set(key, count + 1)

    const stream = openSse(request, response)
    const token = readCookie(request.headers.cookie, SESSION_COOKIE)
    const recheck = setInterval(() => {
      void this.stillSignedIn(token, operator).then((ok) => {
        if (!ok) stream.close()
      })
    }, this.recheckMs)
    stream.onClose(() => {
      clearInterval(recheck)
      const left = (this.open.get(key) ?? 1) - 1
      if (left > 0) this.open.set(key, left)
      else this.open.delete(key)
    })

    return stream
  }

  /** Сбой базы при перепроверке — не повод рвать поток: следующая проверка решит */
  private async stillSignedIn(token: string | null, operator: Operator): Promise<boolean> {
    if (!token) return false
    try {
      return (await this.auth.resolve(token))?.id === operator.id
    } catch {
      return true
    }
  }
}
