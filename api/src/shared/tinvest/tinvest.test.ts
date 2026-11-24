import { describe, expect, test } from 'bun:test'
import { X509Certificate } from 'node:crypto'
import { TINVEST_ROOT_CA_PEM, TINVEST_ROOT_CA_SHA256 } from './tinvest'

describe('корень T-Invest', () => {
  test('файл — Russian Trusted Root CA с закреплённым отпечатком', () => {
    const certificate = new X509Certificate(TINVEST_ROOT_CA_PEM)

    expect(certificate.fingerprint256).toBe(TINVEST_ROOT_CA_SHA256)
    expect(certificate.subject).toContain('CN=Russian Trusted Root CA')
    expect(certificate.ca).toBe(true)
  })
})
