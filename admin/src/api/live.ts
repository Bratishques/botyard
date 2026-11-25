/**
 * Живой статус развёртываний.
 *
 * - Основной путь — SSE `GET /events/deployments`: событие `deployment` с id — сигнал перечитать это развёртывание
 *   и список (сами данные в событии не приходят, правда — в API). `resync` и переподключение потока — события
 *   могли потеряться, перечитывается всё.
 * - Запасной путь — опрос: пока у развёртывания идёт операция, его запрос перечитывается каждые `POLL_MS`. Он же
 *   ведёт статус, пока поток оборван. Экраны берут интервал только отсюда и не знают, откуда пришло обновление.
 *
 * Оптимистичных переходов нет: интерфейс показывает статус, который вернул сервер.
 */
import type { DeploymentChangedEvent, DeploymentView, LogLine } from '@botyard/contract'

export const POLL_MS = 3000

/**
 * Идёт ли у развёртывания работа, за которой стоит следить. Признак — активная операция, а не статус: упавшее
 * удаление оставляет `DELETING` без операции, и опрашивать его бесконечно незачем
 */
export function isBusy(deployment: Pick<DeploymentView, 'activeOperationId'>): boolean {
  return deployment.activeOperationId !== null
}

/** Интервал перечитывания для одного развёртывания: опрос только пока идёт операция */
export function deploymentRefetchInterval(deployment: DeploymentView | undefined): number | false {
  return deployment && isBusy(deployment) ? POLL_MS : false
}

/** Для списка: опрос, пока хоть одно развёртывание занято */
export function deploymentsRefetchInterval(deployments: DeploymentView[] | undefined): number | false {
  return deployments?.some(isBusy) ? POLL_MS : false
}

/** Что нужно от кеша запросов: только инвалидация по ключу */
export interface Invalidator {
  invalidateQueries(filters: { queryKey: readonly unknown[]; exact?: boolean }): Promise<unknown>
}

/** Минимум `EventSource`, нужный здесь (в тестах — подделка) */
export interface EventSourceLike {
  readonly readyState: number
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void
  close(): void
  onerror: ((event: Event) => void) | null
  onopen: ((event: Event) => void) | null
}

export type EventSourceFactory = (url: string) => EventSourceLike

const EVENT_SOURCE_CLOSED = 2
/** Пауза перед новым потоком, если браузер сам переподключаться не стал (не-200: 401, 429) */
export const EVENTS_RETRY_MS = 5_000
export const EVENTS_MAX_RETRY_MS = 60_000

/**
 * Подписка на поток событий развёртываний с инвалидацией запросов. Возвращает отключение.
 * Ключи — те же, что у `queryKeys` (`['deployments']` и `['deployments', id]`): инвалидация по префиксу
 * `['deployments']` перечитывает и список, и все открытые карточки.
 */
export function connectDeploymentEvents(
  cache: Invalidator,
  options: {
    open?: EventSourceFactory
    url?: string
    /**
     * Перед новым потоком после закрытого: жива ли сессия. `EventSource` не видит статуса ответа, и без проверки
     * вкладка после выхода в другой бесконечно ловила бы 401 и показывала данные прежнего оператора. Проверка идёт
     * обычным запросом — его 401 сам переводит на вход
     */
    sessionAlive?: () => Promise<boolean>
    retryMs?: number
  } = {},
): () => void {
  const open = options.open ?? ((url: string) => new EventSource(url))
  const url = options.url ?? '/api/events/deployments'
  const sessionAlive = options.sessionAlive ?? (async () => true)
  const baseRetryMs = options.retryMs ?? EVENTS_RETRY_MS
  let source: EventSourceLike | null = null
  let retry: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  let failures = 0
  const all = () => void cache.invalidateQueries({ queryKey: ['deployments'] })

  const connect = () => {
    const current = open(url)
    source = current
    current.onopen = () => {
      // Каждое открытие, и первое тоже: события до подписки или за разрыв потеряны, а без активной операции их
      // не подберёт и опрос
      failures = 0
      all()
    }
    current.addEventListener('deployment', (event) => {
      const data = parseEvent<DeploymentChangedEvent>(event)
      if (!data) return all()
      void cache.invalidateQueries({ queryKey: ['deployments', data.deploymentId] })
      // Список — без перечитывания открытых карточек других развёртываний
      void cache.invalidateQueries({ queryKey: ['deployments'], exact: true })
    })
    current.addEventListener('resync', all)
    current.onerror = () => {
      // Обрыв сети браузер переподключает сам; закрытый поток (ответ не 200) — нет: новый через растущую паузу,
      // и только если сессия жива
      if (stopped || current.readyState !== EVENT_SOURCE_CLOSED || retry) return
      current.close()
      failures++
      retry = setTimeout(
        () => {
          void sessionAlive().then(
            (alive) => {
              retry = null
              if (!stopped && alive) connect()
            },
            () => {
              retry = null
              if (!stopped) connect()
            },
          )
        },
        Math.min(baseRetryMs * 2 ** (failures - 1), EVENTS_MAX_RETRY_MS),
      )
    }
  }
  connect()

  return () => {
    stopped = true
    if (retry) clearTimeout(retry)
    source?.close()
  }
}

function parseEvent<T>(event: MessageEvent<string>): T | null {
  try {
    return JSON.parse(event.data) as T
  } catch {
    return null
  }
}

/** Столько строк лога держит экран: дальше старые отбрасываются */
export const LOG_LINES_KEPT = 2000

/**
 * Строки живого лога без повторов. Сервер отдаёт каждую строку один раз, но `EventSource` после обрыва
 * переподключается сам — и новый поток начинается снова с хвоста. Повтор — строка не новее последней с тем же
 * текстом в момент последней: так же сервер отсекает повторы у себя
 */
export class LogBuffer {
  private lines: LogLine[] = []
  private lastAt: string | null = null
  private atLast = new Set<string>()

  get all(): readonly LogLine[] {
    return this.lines
  }

  /** Пометка в ленте (пропуск строк) — со временем последней строки, чтобы не сбить отсев повторов */
  mark(text: string): boolean {
    if (this.lastAt === null) return false
    this.lines = [...this.lines.slice(-(LOG_LINES_KEPT - 1)), { at: this.lastAt, text }]
    return true
  }

  /** Добавить строку; `false` — повтор */
  push(line: LogLine): boolean {
    if (this.lastAt !== null && (line.at < this.lastAt || (line.at === this.lastAt && this.atLast.has(line.text)))) return false
    if (line.at !== this.lastAt) this.atLast = new Set()
    this.atLast.add(line.text)
    this.lastAt = line.at
    this.lines = [...this.lines.slice(-(LOG_LINES_KEPT - 1)), line]
    return true
  }
}

export type LogStreamEvent =
  | { kind: 'open' }
  | { kind: 'lines'; lines: readonly LogLine[] }
  | { kind: 'warning'; code: string }
  | { kind: 'closed'; code: string | null }

/**
 * Живой поток логов вне React: открыть, разобрать события, закрыть. Состояние потока (`open`, `closed`) — только в
 * событиях наружу, сам поток живёт до `close()`. Повторы после переподключения отсекает `LogBuffer`, разрыв
 * (`logs-gap`) ставит пометку в ленту. `closed` — поток кончился: `DEPLOYMENT_NOT_FOUND` или ответ не 200 (код
 * тогда `null` — причину выясняет вызывающий)
 */
export function openLogStream(
  url: string,
  onEvent: (event: LogStreamEvent) => void,
  open: EventSourceFactory = (u) => new EventSource(u),
): () => void {
  const buffer = new LogBuffer()
  const source = open(url)
  let closed = false
  const finish = (code: string | null) => {
    if (closed) return
    closed = true
    source.close()
    onEvent({ kind: 'closed', code })
  }
  source.onopen = () => onEvent({ kind: 'open' })
  source.addEventListener('log', (event) => {
    const line = parseEvent<LogLine>(event)
    if (line && typeof line.at === 'string' && typeof line.text === 'string' && buffer.push(line)) {
      onEvent({ kind: 'lines', lines: buffer.all })
    }
  })
  source.addEventListener('logs-gap', () => {
    if (buffer.mark(LOG_GAP_TEXT)) onEvent({ kind: 'lines', lines: buffer.all })
  })
  source.addEventListener('logs-error', (event) => {
    const code = parseEvent<{ code?: string }>(event)?.code ?? 'LOGS_UNAVAILABLE'
    if (code === 'DEPLOYMENT_NOT_FOUND') finish(code)
    else onEvent({ kind: 'warning', code })
  })
  source.onerror = () => {
    if (source.readyState === EVENT_SOURCE_CLOSED) finish(null)
  }

  return () => {
    closed = true
    source.close()
  }
}

export const LOG_GAP_TEXT = '… часть строк пропущена: робот печатал быстрее, чем их успевали читать …'
