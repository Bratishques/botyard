import { describe, expect, test } from 'bun:test'
import { checkTemplate } from './template-variables'

const schema = {
  type: 'object',
  properties: {
    figi: { type: 'array', items: { type: 'string' } },
    logLevel: { type: 'string' },
    instruments: { type: 'array', items: { type: 'object', properties: { figi: { type: 'string' }, depth: { type: 'integer' } } } },
  },
}

describe('checkTemplate', () => {
  test('допускает поля схемы, переменные платформы, join и each по массиву объектов', () => {
    const source = `{{ config.logLevel }} {{join config.figi ","}} {{ customer.accountId }} {{ customer.sandbox }}
{{ secret.tinvestToken }} {{ platform.tinvestAddress }}
{{#each config.instruments}}{{ figi }}={{ depth }}{{#if @first}}!{{/if}}{{/each}}`

    expect(checkTemplate(source, schema)).toEqual([])
  })

  test.each([
    ['{{ config.figis }}', 'unknown variable "config.figis"'],
    ['{{ secret.apiKey }}', 'unknown variable "secret.apiKey"'],
    ['{{ process.env.HOME }}', 'unknown variable "process.env.HOME"'],
    ['{{#each config.instruments}}{{ dpth }}{{/each}}', 'unknown variable "dpth"'],
    ['{{#each config.figi}}{{ this }}{{/each}}', 'must iterate an array of objects'],
    ['{{lookup config "figi"}}', 'helper "lookup" is not allowed'],
    ['{{#with config}}{{/with}}', 'block helper "with" is not allowed'],
    ['{{> partial}}', 'partials and decorators are not allowed'],
    ['{{ config.logLevel', 'does not compile'],
  ])('отклоняет %s', (source, problem) => {
    expect(checkTemplate(source, schema).join('; ')).toContain(problem)
  })
})
