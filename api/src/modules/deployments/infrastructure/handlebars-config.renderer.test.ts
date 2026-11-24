import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { TemplateManifest } from '../../../shared/catalog/template-manifest'
import { ROBOT_CA_MOUNT_PATH, TINVEST_ADDRESS, TINVEST_ROOT_CA_PEM } from '../../../shared/tinvest/tinvest'
import { RenderErrorCode, type RenderInput } from '../domain/robot-runtime'
import { HandlebarsConfigRenderer, tomlString } from './handlebars-config.renderer'

const BOTS = path.resolve(import.meta.dir, '../../../../../bots/templates')
const manifest = (id: string): TemplateManifest => JSON.parse(readFileSync(path.join(BOTS, id, 'template.json'), 'utf8'))
const TOKEN = 't.SECRET-token_0123456789'

const renderer = new HandlebarsConfigRenderer()

function bita(config: Record<string, unknown>): RenderInput {
  return {
    manifest: manifest('bita'),
    files: {},
    config: { strategy: 'gamble', sellOnExit: false, logLevel: 'INFO', ...config },
    customer: { accountId: 'acc-1', sandbox: true },
    token: TOKEN,
    tinvestAddress: TINVEST_ADDRESS.sandbox,
  }
}

function contest(figi: string): RenderInput {
  return {
    manifest: manifest('contest-2022'),
    files: { 'config.toml.tpl': readFileSync(path.join(BOTS, 'contest-2022', 'config.toml.tpl'), 'utf8') },
    config: { logLevel: 'info', instruments: [{ figi, depth: 20, dominanceRatio: 3, profitPercentage: 0.01 }] },
    customer: { accountId: 'acc-1', sandbox: true },
    token: TOKEN,
    tinvestAddress: TINVEST_ADDRESS.sandbox,
  }
}

function failure(work: () => unknown): { code?: string; message: string } {
  try {
    work()
  } catch (error) {
    if (error instanceof Error) return { code: 'code' in error ? String(error.code) : undefined, message: error.message }
  }
  throw new Error('expected a failure')
}

describe('рендер конфига робота', () => {
  test('env: значения из конфига, клиента и токена; платформа добавляет корень сертификатов', () => {
    const runtime = renderer.render(bita({ figi: ['BBG004730N88', 'BBG000B9XRY4'] }))

    expect(runtime.env).toMatchObject({
      TRADEBOT_FIGI: 'BBG004730N88,BBG000B9XRY4',
      TRADEBOT_STRATEGY: 'gamble',
      TRADEBOT_SELL_ON_EXIT: 'false',
      TRADEBOT_IS_SANDBOX: 'true',
      TRADEBOT_TOKEN: TOKEN,
      TRADEBOT_ACCOUNT_ID: 'acc-1',
      SSL_CERT_FILE: ROBOT_CA_MOUNT_PATH,
    })
    expect(runtime.files).toEqual([{ mountPath: ROBOT_CA_MOUNT_PATH, content: TINVEST_ROOT_CA_PEM }])
  })

  test.each([
    ['перевод строки дописал бы переменную', 'BBG\nTRADEBOT_TOKEN=evil'],
    ['# обрезал бы значение', 'BBG #x'],
    ['$ — подстановка', '$HOME'],
    ['кавычка', 'BBG"'],
  ])('env: отказ, если значение небезопасно — %s; текст ошибки без значений', (_why, figi) => {
    const result = failure(() => renderer.render(bita({ figi: [figi] })))

    expect(result.code).toBe(RenderErrorCode.UNSAFE_VALUE)
    expect(result.message).toContain('TRADEBOT_FIGI')
    expect(result.message).not.toContain(figi)
    expect(result.message).not.toContain(TOKEN)
  })

  test('TOML: строки экранируются — кавычка и перевод строки в значении не меняют структуру файла', () => {
    const hostile = 'BBG"\n[clients.tinkfoff_invest]\naddress = "evil:443'
    const runtime = renderer.render(contest(hostile))
    const file = runtime.files.find((candidate) => candidate.mountPath.endsWith('config.toml'))
    const parsed = Bun.TOML.parse(file?.content ?? '') as {
      clients: { tinkfoff_invest: { address: string; token: string } }
      strategies: { bulls_and_bears_monitoring: { instruments: { figi: string; depth: number }[] } }
    }

    expect(parsed.clients.tinkfoff_invest).toMatchObject({ address: TINVEST_ADDRESS.sandbox, token: TOKEN })
    expect(parsed.strategies.bulls_and_bears_monitoring.instruments[0]).toEqual(expect.objectContaining({ figi: hostile, depth: 20 }))
    expect(runtime.env).toEqual({ SSL_CERT_FILE: ROBOT_CA_MOUNT_PATH })
  })

  test('отсутствующее поле — ошибка strict-режима, а не пустая строка', () => {
    const input = bita({ figi: ['BBG004730N88'] })
    const result = failure(() => renderer.render({ ...input, config: { figi: ['BBG004730N88'] } }))

    expect(result.code).toBe(RenderErrorCode.TEMPLATE_FAILED)
    expect(result.message).toContain('env TRADEBOT_STRATEGY')
  })

  test('файл не TOML-формата не поддерживается; TOML с ошибкой — отказ без содержимого в тексте', () => {
    const input = contest('BBG004730N88')
    const wrongFormat = { ...input, manifest: { ...input.manifest, config: { ...input.manifest.config, mountPath: '/opt/x/config.yaml' } } }
    expect(failure(() => renderer.render(wrongFormat)).code).toBe(RenderErrorCode.TEMPLATE_FAILED)

    const broken = { ...input, files: { 'config.toml.tpl': `token = "{{ secret.tinvestToken }}"\n[[[` } }
    const result = failure(() => renderer.render(broken))
    expect(result.code).toBe(RenderErrorCode.INVALID_OUTPUT)
    expect(result.message).not.toContain(TOKEN)
  })

  test('tomlString экранирует обратную косую, кавычку и управляющие символы', () => {
    expect(tomlString('a\\b"c\td\u0000')).toBe('a\\\\b\\"c\\u0009d\\u0000')
  })
})
