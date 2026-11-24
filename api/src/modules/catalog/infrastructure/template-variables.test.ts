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
{{#each config.instruments}}{{ figi }}={{ depth }}{{#if @first}}!{{/if}}{{ @index }}{{ ../config.logLevel }}{{/each}}`

    expect(checkTemplate(source, schema)).toEqual([])
  })

  test('поле элемента с именем хелпера отклоняется: Handlebars вызвал бы хелпер', () => {
    const helperish = {
      type: 'object',
      properties: {
        rows: { type: 'array', items: { type: 'object', properties: { log: { type: 'string' }, lookup: { type: 'string' } } } },
      },
    }

    expect(checkTemplate('{{#each config.rows}}{{log}}{{/each}}', helperish).join('; ')).toContain('has the name of a helper')
    expect(checkTemplate('{{#each config.rows}}{{lookup}}{{/each}}', helperish).join('; ')).toContain('has the name of a helper')
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
    ['{{ @root.config.figis }}', 'data variable "@root.config.figis" is not allowed'],
    ['{{ @root.secret.apiKey }}', 'data variable "@root.secret.apiKey" is not allowed'],
    ['{{ @index }}', 'data variable "@index" is not allowed'],
    ['{{#each config.instruments}}{{ @root }}{{/each}}', 'data variable "@root" is not allowed'],
    ['{{join config.figi "," x=config.typo}}', 'hash arguments are not allowed'],
    ['{{#if config.logLevel x=config.nope}}{{/if}}', 'hash arguments are not allowed'],
    ['{{* deco }}', 'partials and decorators are not allowed'],
    ['{{#each}}{{/each}}', '{{#each}} takes exactly one argument'],
    ['{{#if config.logLevel config.figi}}{{/if}}', '{{#if}} takes exactly one argument'],
    ['{{ ../config.logLevel }}', 'unknown variable "../config.logLevel"'],
    ['{{#each config.instruments}}{{ ../../config.logLevel }}{{/each}}', 'unknown variable "../../config.logLevel"'],
    ['{{ config.constructor }}', 'unknown variable "config.constructor"'],
    ['{{ config.toString }}', 'unknown variable "config.toString"'],
    ['{{[customer.accountId]}}', 'path segment "[customer.accountId]" is not a plain name'],
    ['{{[secret.tinvestToken]}}', 'path segment "[secret.tinvestToken]" is not a plain name'],
    ['{{#each config.instruments}}{{@../index}}{{/each}}', 'data variable "@../index" is not allowed'],
    ['{{#each config.instruments as |figi|}}{{figi}}{{/each}}', 'block parameters (as |x|) are not allowed'],
    ['{{join config.logLevel ","}}', 'join takes an array of scalars, config.logLevel is not one'],
    ['{{join config.figi}}', 'join takes an array field and a string separator'],
    ['{{join config.instruments ","}}', 'join takes an array of scalars'],
  ])('отклоняет %s', (source, problem) => {
    expect(checkTemplate(source, schema).join('; ')).toContain(problem)
  })
})
