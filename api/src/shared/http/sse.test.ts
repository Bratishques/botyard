import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { Request, Response } from 'express'
import { openSse, SSE_MAX_BUFFERED_BYTES } from './sse'

/** Минимальные запрос и ответ express для потока: события закрытия и запись */
function fakes(options: { destroyed: boolean }) {
  const request = Object.assign(new EventEmitter(), { destroyed: options.destroyed })
  const written: string[] = []
  let ended = false
  const response = Object.assign(new EventEmitter(), {
    writableEnded: false,
    destroyed: false,
    writableLength: 0,
    status: () => response,
    setHeader: () => response,
    flushHeaders: () => undefined,
    write: (chunk: string) => written.push(chunk),
    end: () => {
      ended = true
    },
  })
  return { request: request as unknown as Request, response: response as unknown as Response, written, ended: () => ended }
}

describe('SSE', () => {
  test('клиент ушёл раньше, чем поток открыли, — поток закрывается сразу, подписки снимаются', async () => {
    const { request, response, ended } = fakes({ destroyed: true })
    let released = false

    const stream = openSse(request, response)
    stream.onClose(() => {
      released = true
    })
    await Promise.resolve()

    expect(released).toBe(true)
    expect(ended()).toBe(true)
  })

  test('событие пишется одной записью; после закрытия ответа запись прекращается', () => {
    const { request, response, written } = fakes({ destroyed: false })
    const stream = openSse(request, response)

    stream.send('deployment', { deploymentId: 'x' })
    ;(response as unknown as EventEmitter).emit('close')
    stream.send('deployment', { deploymentId: 'y' })

    expect(written.filter((chunk) => chunk.startsWith('event:'))).toEqual(['event: deployment\ndata: {"deploymentId":"x"}\n\n'])
  })

  test('клиент не читает и буфер перерос предел — поток закрывается, а не копит память', () => {
    const { request, response, ended } = fakes({ destroyed: false })
    const stream = openSse(request, response)

    stream.send('log', { text: 'ok' })
    expect(ended()).toBe(false)
    ;(response as unknown as { writableLength: number }).writableLength = SSE_MAX_BUFFERED_BYTES + 1
    stream.send('log', { text: 'one more' })

    expect(ended()).toBe(true)
  })
})
