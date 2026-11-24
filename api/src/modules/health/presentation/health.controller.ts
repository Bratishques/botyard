import { Controller, Get, HttpCode, Inject, Logger, ServiceUnavailableException } from '@nestjs/common'
import { Public } from '../../auth/presentation/session.guard'
import { READINESS_CHECKS, type ReadinessCheck } from '../domain/readiness-check'

/**
 * live — процесс жив, иначе оркестратор его перезапустит.
 * ready — процесс готов принимать трафик. Проверяются только собственные зависимости (БД),
 * но не Dokploy: недоступное назначение — не повод выводить из балансировки весь api.
 */
@Public()
@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name)

  constructor(@Inject(READINESS_CHECKS) private readonly checks: ReadinessCheck[]) {}

  @Get('live')
  @HttpCode(200)
  live(): { status: 'ok' } {
    return { status: 'ok' }
  }

  @Get('ready')
  async ready(): Promise<{ status: 'ok'; checks: Record<string, 'ok'> }> {
    const results = await Promise.all(
      this.checks.map(async (check) => {
        try {
          await check.probe()
          return [check.name, 'ok'] as const
        } catch (error) {
          // Причина нужна, чтобы понять, почему под вывели из балансировки. Только код и текст ошибки:
          // объект подключения со строкой соединения в лог не идёт
          const reason =
            error instanceof Error ? { code: (error as { code?: unknown }).code, message: error.message } : { message: String(error) }
          this.logger.warn({ check: check.name, ...reason }, 'readiness check failed')
          return [check.name, 'fail'] as const
        }
      }),
    )
    const failed = results.filter(([, status]) => status === 'fail').map(([name]) => name)
    if (failed.length > 0) throw new ServiceUnavailableException({ status: 'fail', failed })

    return { status: 'ok', checks: Object.fromEntries(results) as Record<string, 'ok'> }
  }
}
