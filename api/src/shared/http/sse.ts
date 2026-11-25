import type { Request, Response } from 'express'

/** Пульс — чаще типичного таймаута простоя прокси (Traefik, nginx — 60 с): соединение не обрывают как пустое */
const HEARTBEAT_MS = 25_000
/** Столько непереданного держит медленный клиент — дальше поток закрывается, а не копит память процесса */
export const SSE_MAX_BUFFERED_BYTES = 1024 * 1024

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
  const write = (chunk: string) => {
    if (closed) return
    response.write(chunk)
    // Клиент не читает (зависшая вкладка, медленная сеть): буфер ответа растёт без предела. Рвать сокет, а не
    // `end()`: FIN встал бы в очередь за буфером, который не уйдёт, и соединение с мегабайтом висело бы без срока
    if ((response.writableLength ?? 0) > SSE_MAX_BUFFERED_BYTES) {
      finish()
      response.destroy()
    }
  }
  const heartbeat = setInterval(() => write(': ping\n\n'), HEARTBEAT_MS)
  const finish = () => {
    if (closed) return
    closed = true
    clearInterval(heartbeat)
    for (const listener of listeners) listener()
    response.end()
  }
  // Клиент мог уйти раньше, чем поток открыли (пока шли сессия и первое чтение логов): тогда `close` уже был и не
  // повторится — проверить сразу. И слушать закрытие и запроса, и ответа: под Bun события приходят по-разному
  request.on('close', finish)
  response.on('close', finish)
  if (request.destroyed || response.writableEnded || response.destroyed) queueMicrotask(finish)

  return {
    send(event, data) {
      write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    },
    onClose(listener) {
      if (closed) listener()
      else listeners.push(listener)
    },
    close: finish,
  }
}
