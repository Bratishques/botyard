import { BadRequestException, type PipeTransform } from '@nestjs/common'
import type { z } from 'zod'

/**
 * Проверка тела запроса zod-схемой. Ошибка — `400 VALIDATION_FAILED` с путями полей, без значений:
 * в теле бывают секреты (ключ Dokploy), и эхо ввода в ответе их бы раскрыло.
 */
export class ZodBody<S extends z.ZodType> implements PipeTransform<unknown, z.infer<S>> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.infer<S> {
    const parsed = this.schema.safeParse(value)
    if (!parsed.success) {
      const fields = parsed.error.issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
      throw new BadRequestException({ code: 'VALIDATION_FAILED', message: fields.join('; ') })
    }

    return parsed.data
  }
}
