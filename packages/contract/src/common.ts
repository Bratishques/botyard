import { z } from 'zod'

/** Версия записи для условной правки: устаревшая — 409 `*_VERSION_CONFLICT` */
export const version = z.number().int().positive()
export const versionSchema = z.object({ version }).strict()
export type VersionBody = z.infer<typeof versionSchema>

/** `Idempotency-Key`: 8–128 символов `A-Z a-z 0-9 - _`, один ключ — одна попытка пользователя */
export const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,128}$/

/** Тело любой ошибки API. Показывать по `code`, `message` — для логов */
export interface ErrorBody {
  code: string
  message: string
}
