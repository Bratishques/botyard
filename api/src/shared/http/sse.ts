import type { Request, Response } from 'express'

/** Пульс — чаще типичного таймаута простоя прокси (Traefik, nginx — 60 с): соединение не обрывают как пустое */
const HEARTBEAT_MS = 25_000

export interface SseStream {
  send(event: string, data: unknown): void
  /** Срабатывает один раз, когда клиент ушёл или поток закрыли */
  onClose(listener: () => void): void
  close(): void
}

/**
 * Server-Sent Events поверх ответа express: заголовки потока, пульс-комментарий, закрытие при уходе клиента.
 * Данные — JSON одной строкой; браузерный `EventSource` сам переподключается, поэтому поток — подсказка, а не
 * единственный канал: при переподключении клиент перечитывает состояние через API.
 */
export function openSse(request: Request, response: Response): SseStream {
  response.status(200)
  response.setHeader('content-type', 'text/event-stream; charset=utf-8')
  response.setHeader('cache-control', 'no-cache, no-transform')
  response.setHeader('connection', 'keep-alive')
  // Буферизующий прокси (nginx) иначе копил бы события
  response.setHeader('x-accel-buffering', 'no')
  response.flushHeaders()
  response.write(': connected\n\n')

  const listeners: (() => void)[] = []
  let closed = false
  const heartbeat = setInterval(() => response.write(': ping\n\n'), HEARTBEAT_MS)
  const finish = () => {
    if (closed) return
    closed = true
    clearInterval(heartbeat)
    for (const listener of listeners) listener()
    response.end()
  }
  request.on('close', finish)

  return {
    send(event, data) {
      if (!closed) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    },
    onClose(listener) {
      if (closed) listener()
      else listeners.push(listener)
    },
    close: finish,
  }
}
