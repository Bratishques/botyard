import { describe, expect, test } from 'bun:test'
import { canonicalJson } from '../../../shared/json/canonical-json'
import { type TemplateSource, templateVersion } from './catalog'

const source: TemplateSource = {
  manifest: {
    id: 'bita',
    name: 'BITA',
    upstream: { gitUrl: 'https://github.com/elkopass/BITA.git', ref: 'main', license: 'Apache-2.0' },
    build: { type: 'dockerfile', dockerfile: 'cmd/trade-bot/Dockerfile', context: '.' },
    config: { delivery: 'env', schema: { type: 'object' }, env: { A: '1' } },
    security: { verifiesTls: true },
  },
  files: {},
}

describe('templateVersion', () => {
  test('перестановка полей не меняет версию, правка значения — меняет', () => {
    const reversedManifest = Object.fromEntries(Object.entries(source.manifest).reverse()) as unknown as TemplateSource['manifest']
    const reordered = { ...source, manifest: reversedManifest }
    const changed = { ...source, manifest: { ...source.manifest, upstream: { ...source.manifest.upstream, ref: 'v2' } } }

    expect(templateVersion(reordered)).toBe(templateVersion(source))
    expect(templateVersion(changed)).not.toBe(templateVersion(source))
    expect(templateVersion(source)).toMatch(/^[0-9a-f]{64}$/)
  })

  test('файлы шаблона входят в версию', () => {
    expect(templateVersion({ ...source, files: { 'config.toml.tpl': 'a' } })).not.toBe(
      templateVersion({ ...source, files: { 'config.toml.tpl': 'b' } }),
    )
  })
})

describe('canonicalJson', () => {
  test('сортирует ключи на любой глубине и не трогает порядок массивов', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, 1], c: null } })).toBe('{"a":{"c":null,"d":[2,1]},"b":1}')
  })
})
