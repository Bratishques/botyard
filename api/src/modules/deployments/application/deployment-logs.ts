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
 * - Dokploy v0.31.4 читает логи одного контейнера приложения; строки сортируются по времени на всякий случай.
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

  async read(deploymentId: string, options: { tail: number; sinceSeconds?: number }): Promise<LogLine[]> {
    const deployment = await this.deployments.findById(deploymentId)
    if (!deployment || deployment.status === 'DELETED') {
      throw new DeploymentError(DeploymentErrorCode.NOT_FOUND, `deployment ${deploymentId} is not found`)
    }
    // Нет приложения или ещё не было деплоя — нет и контейнера: Dokploy ответил бы 500, а это размыкало бы цепь
    // назначения для всех его операций
    if (!deployment.dokployAppId || (deployment.status === 'PROVISIONING' && deployment.activeOperationId !== null)) return []

    const { destination, apiKey } = await this.destinations.connection(deployment.destinationId)
    const token = await this.customers.revealToken(await this.customers.get(deployment.customerId))
    const raw = await this.platform.readLogs(
      { baseUrl: destination.baseUrl, apiKey, environmentId: destination.environmentId, serverId: destination.serverId },
      deployment.dokployAppId,
      {
        tail: Math.min(Math.max(1, options.tail), LOGS.maxTail),
        ...(options.sinceSeconds !== undefined && { sinceSeconds: options.sinceSeconds }),
      },
    )

    return parseLogs(raw, [token, apiKey])
  }
}

/** Позиция потока логов: последнее отданное время и строки с ним (у строк время может совпадать) */
export interface LogCursor {
  readonly at: string
  readonly texts: ReadonlySet<string>
}

/**
 * Новые строки после курсора. Окно запроса берётся с запасом (`since` у Dokploy — в секундах и включает границу),
 * поэтому повторы отсекаются здесь: раньше курсора — уже отдано, ровно на курсоре — отдано, если текст тот же
 */
export function linesAfter(lines: readonly LogLine[], cursor: LogCursor | null): { fresh: LogLine[]; cursor: LogCursor | null } {
  let at = cursor?.at
  let texts = new Set(cursor?.texts ?? [])
  const fresh: LogLine[] = []
  for (const line of lines) {
    if (at !== undefined && (line.at < at || (line.at === at && texts.has(line.text)))) continue
    fresh.push(line)
    if (line.at !== at) texts = new Set()
    texts.add(line.text)
    at = line.at
  }

  return { fresh, cursor: at === undefined ? null : { at, texts } }
}

/** Сколько секунд назад была строка — окно `since` для следующего опроса, с запасом на часы Docker и задержку */
export function sinceSecondsFor(cursor: LogCursor | null, now = Date.now()): number | undefined {
  if (!cursor) return undefined
  const at = Date.parse(cursor.at)
  if (Number.isNaN(at)) return undefined

  return Math.max(1, Math.ceil((now - at) / 1000) + LOG_WINDOW_MARGIN_S)
}

const LOG_WINDOW_MARGIN_S = 5

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
