import { expect, test } from 'bun:test'
import { safeRedirect } from './redirect'

test('возврат после входа: только свой путь, без другого хоста и без петли на вход', () => {
  expect(safeRedirect('/deployments/abc?tab=ops#x')).toBe('/deployments/abc?tab=ops#x')
  expect(safeRedirect('//evil.example')).toBeUndefined()
  expect(safeRedirect('/\\evil.example')).toBeUndefined()
  expect(safeRedirect('https://evil.example')).toBeUndefined()
  expect(safeRedirect('/login?redirect=/x')).toBeUndefined()
  expect(safeRedirect(42)).toBeUndefined()
})
