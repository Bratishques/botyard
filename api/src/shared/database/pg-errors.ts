/** Нарушение уникального индекса Postgres (23505); `constraint` — имя индекса, по нему понятно, что занято */
export function isUniqueViolation(error: unknown): error is { code: '23505'; constraint?: string } {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505'
}
