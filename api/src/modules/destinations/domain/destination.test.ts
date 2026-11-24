import { describe, expect, test } from 'bun:test'
import { DestinationErrorCode, normalizeBaseUrl } from './destination'

const strict = { allowHttp: false }

describe('normalizeBaseUrl', () => {
  test.each([
    ['https://Dokploy.Example.com', 'https://dokploy.example.com'],
    ['https://dokploy.example.com/', 'https://dokploy.example.com'],
    ['https://dokploy.example.com.', 'https://dokploy.example.com'],
    ['https://dokploy.example.com:443', 'https://dokploy.example.com'],
    ['https://dokploy.example.com:0443', 'https://dokploy.example.com'],
    ['https://dokploy.example.com:8443/', 'https://dokploy.example.com:8443'],
    ['https://dokploy.example.com/panel/?x=1#y', 'https://dokploy.example.com/panel'],
    ['  https://dokploy.example.com  ', 'https://dokploy.example.com'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeBaseUrl(input, strict)).toBe(expected)
  })

  test('варианты написания одного инстанса дают одну строку', () => {
    const variants = ['https://D.example.com', 'https://d.example.com:443/', 'https://d.example.com.']

    expect(new Set(variants.map((url) => normalizeBaseUrl(url, strict))).size).toBe(1)
  })

  test('http — только явным флагом', () => {
    expect(() => normalizeBaseUrl('http://localhost:3000', strict)).toThrow('https')
    expect(normalizeBaseUrl('http://localhost:3000', { allowHttp: true })).toBe('http://localhost:3000')
    expect(normalizeBaseUrl('http://localhost:80', { allowHttp: true })).toBe('http://localhost')
  })

  test.each(['not a url', 'ftp://dokploy.example.com', 'https://user:pass@dokploy.example.com', 'https://dok_ploy.example.com'])(
    'отклоняет %s',
    (input) => {
      try {
        normalizeBaseUrl(input, strict)
        throw new Error('accepted')
      } catch (error) {
        expect((error as { code?: string }).code).toBe(DestinationErrorCode.INVALID_URL)
      }
    },
  )
})
