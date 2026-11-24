import { Inject, Injectable } from '@nestjs/common'
import { redactString } from '../../../shared/observability/redact'
import { CustomerUseCases } from '../../customers/application/customer-use-cases'
import { DestinationUseCases } from '../../destinations/application/destination-use-cases'
import { DEPLOYMENT_REPOSITORY, DeploymentError, DeploymentErrorCode, type DeploymentRepository } from '../domain/deployment'
import { DEPLOYMENT_PLATFORM, type DeploymentPlatform } from '../domain/deployment-platform'

export interface LogLine {
  /** Время строки от Docker (RFC3339Nano) */
  readonly at: string
  readonly text: string
}

export const LOGS = {
  maxTail: 1_000,
  defaultTail: 200,
} as const

const LINE = /^(\d{4}-\d{2}-\d{2}T\S+Z)\s(.*)$/

/**
 * Логи робота из Dokploy (`application.readLogs`) для админки.
 *
 * - Робот может напечатать свой токен: каждая строка вычищается от токена клиента (точное значение) и проходит
 *   маску логов (`t.…`, ключи) — токен не уходит оператору, который видит только его подсказку.
 * - Строки разных задач swarm Dokploy отдаёт вперемешку — здесь они сортируются по времени.
 * - Ключ Dokploy и токен открываются на время запроса и не сохраняются.
 */
@Injectable()
export class DeploymentLogs {
  constructor(
    @Inject(DEPLOYMENT_REPOSITORY) private readonly deployments: DeploymentRepository,
    @Inject(DEPLOYMENT_PLATFORM) private readonly platform: DeploymentPlatform,
    private readonly destinations: DestinationUseCases,
    private readonly customers: CustomerUseCases,
  ) {}

  async read(deploymentId: string, options: { tail: number; since?: string }): Promise<LogLine[]> {
    const deployment = await this.deployments.findById(deploymentId)
    if (!deployment) throw new DeploymentError(DeploymentErrorCode.NOT_FOUND, `deployment ${deploymentId} is not found`)
    if (!deployment.dokployAppId) return []

    const { destination, apiKey } = await this.destinations.connection(deployment.destinationId)
    const token = await this.customers.revealToken(await this.customers.get(deployment.customerId))
    const raw = await this.platform.readLogs(
      { baseUrl: destination.baseUrl, apiKey, environmentId: destination.environmentId, serverId: destination.serverId },
      deployment.dokployAppId,
      { tail: Math.min(Math.max(1, options.tail), LOGS.maxTail), ...(options.since && { since: options.since }) },
    )

    return parseLogs(raw, [token, apiKey])
  }
}

/** Строки `<время> <текст>` → по времени, с вычищенными секретами; строки без времени отбрасываются */
export function parseLogs(raw: string, secrets: readonly string[]): LogLine[] {
  const lines: LogLine[] = []
  for (const line of raw.split('\n')) {
    const match = LINE.exec(line.trimEnd())
    if (!match?.[1]) continue
    let text = match[2] ?? ''
    for (const secret of secrets) if (secret.length >= 4) text = text.split(secret).join('<secret>')
    lines.push({ at: match[1], text: redactString(text) })
  }

  return lines.sort((a, b) => a.at.localeCompare(b.at))
}
