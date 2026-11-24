import { z } from 'zod'

export const loginSchema = z.object({ email: z.string().min(3).max(254), password: z.string().min(1).max(256) }).strict()
export type LoginBody = z.infer<typeof loginSchema>

/** Оператор в ответах `POST /auth/login` и `GET /auth/me` */
export interface OperatorView {
  id: string
  email: string
}
