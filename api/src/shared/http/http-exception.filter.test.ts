import { describe, expect, test } from 'bun:test'
import type { ArgumentsHost } from '@nestjs/common'
import { BadRequestException, ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common'
import { HttpExceptionFilter } from './http-exception.filter'

function run(exception: unknown): { status: number; body: unknown } {
  const sent: { status: number; body: unknown } = { status: 0, body: undefined }
  const response = {
    status(code: number) {
      sent.status = code
      return this
    },
    json(body: unknown) {
      sent.body = body
      return this
    },
  }
  const host = { switchToHttp: () => ({ getResponse: () => response }) } as unknown as ArgumentsHost
  new HttpExceptionFilter().catch(exception, host)

  return sent
}

describe('HttpExceptionFilter', () => {
  test('404 роутера не повторяет путь с query', () => {
    const sent = run(new NotFoundException('Cannot GET /nope?token=QUERYSECRET'))

    expect(sent).toEqual({ status: 404, body: { code: 'NOT_FOUND', message: 'route not found' } })
  })

  test('стандартная ошибка Nest приводится к { code, message }', () => {
    expect(run(new BadRequestException('name is required'))).toEqual({
      status: 400,
      body: { code: 'BAD_REQUEST', message: 'name is required' },
    })
  })

  test('ответ со своим кодом или своей формой отдаётся как есть', () => {
    expect(run(new ConflictException({ code: 'DESTINATION_EXISTS', message: 'exists' })).body).toEqual({
      code: 'DESTINATION_EXISTS',
      message: 'exists',
    })
    expect(run(new ServiceUnavailableException({ status: 'fail', failed: ['postgres'] })).body).toEqual({
      status: 'fail',
      failed: ['postgres'],
    })
  })

  test('неизвестная ошибка — 500 без подробностей', () => {
    const sent = run(new Error('connect to postgres://u:secret@db failed'))

    expect(sent).toEqual({ status: 500, body: { code: 'INTERNAL', message: 'internal error' } })
  })
})
