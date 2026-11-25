/** Куда вернуться после входа: только путь своего приложения, иначе вход стал бы открытым редиректом */
export function safeRedirect(value: unknown): string | undefined {
  // `//host` и `/\host` браузер понимает как другой хост
  return typeof value === 'string' && /^\/(?![/\\])/.test(value) && !value.startsWith('/login') ? value : undefined
}
