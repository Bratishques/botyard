import { afterEach, describe, expect, test } from 'bun:test'
import {
  connectDeploymentEvents,
  type EventSourceLike,
  LOG_GAP_TEXT,
  LOG_LINES_KEPT,
  LogBuffer,
  type LogStreamEvent,
  openLogStream,
} from './live'

/** Поддельный EventSource: события и смена состояния — вручную */
class FakeSource implements EventSourceLike {
  readyState = 0
  closed = false
  onerror: ((event: Event) => void) | null = null
  onopen: ((event: Event) => void) | null = null
  private readonly listeners = new Map<string, ((event: MessageEvent<string>) => void)[]>()

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }
  close(): void {
    this.closed = true
    this.readyState = 2
  }
  open(): void {
    this.readyState = 1
    this.onopen?.(new Event('open'))
  }
  emit(type: string, data: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(new MessageEvent(type, { data: JSON.stringify(data) }))
  }
  fail(state: number): void {
    this.readyState = state
    this.onerror?.(new Event('error'))
  }
}

function harness(sessionAlive: () => Promise<boolean> = async () => true) {
  const invalidated: { queryKey: readonly unknown[]; exact?: boolean }[] = []
  const sources: FakeSource[] = []
  let checks = 0
  const stop = connectDeploymentEvents(
    {
      invalidateQueries: async (filters) => {
        invalidated.push(filters)
      },
    },
    {
      open: () => {
        const source = new FakeSource()
        sources.push(source)
        return source
      },
      sessionAlive: () => {
        checks++
        return sessionAlive()
      },
      retryMs: 5,
    },
  )
  return { invalidated, sources, stop, checks: () => checks }
}

let stops: (() => void)[] = []
afterEach(() => {
  for (const stop of stops) stop()
  stops = []
})

describe('живой статус по SSE', () => {
  test('событие перечитывает это развёртывание и сам список, но не чужие карточки', () => {
    const { invalidated, sources, stop } = harness()
    stops.push(stop)
    sources[0]?.open()
    invalidated.length = 0

    sources[0]?.emit('deployment', { deploymentId: 'd1' })

    expect(invalidated).toEqual([{ queryKey: ['deployments', 'd1'] }, { queryKey: ['deployments'], exact: true }])
  })

  test('каждое открытие (и первое: события до подписки потеряны), resync и переподключение перечитывают всё', () => {
    const { invalidated, sources, stop } = harness()
    stops.push(stop)
    sources[0]?.open()
    expect(invalidated).toEqual([{ queryKey: ['deployments'] }])
    invalidated.length = 0

    sources[0]?.emit('resync', {})
    sources[0]?.fail(0) // обрыв сети: браузер переподключится сам
    sources[0]?.open()

    expect(invalidated).toEqual([{ queryKey: ['deployments'] }, { queryKey: ['deployments'] }])
    expect(sources).toHaveLength(1)
  })

  test('поток закрыт сервером — новый через паузу, если сессия жива; отключение отменяет повтор', async () => {
    const live = harness()
    stops.push(live.stop)
    live.sources[0]?.fail(2)
    expect(live.sources).toHaveLength(1)
    await Bun.sleep(30)
    expect(live.checks()).toBe(1)
    expect(live.sources).toHaveLength(2)

    const stopped = harness()
    stopped.sources[0]?.fail(2)
    stopped.stop()
    await Bun.sleep(30)
    expect(stopped.sources).toHaveLength(1)
    expect(stopped.sources[0]?.closed).toBe(true)
  })

  test('сессии нет (выход в другой вкладке) — повторов нет: 401 проверки уводит на вход', async () => {
    const gone = harness(async () => false)
    stops.push(gone.stop)
    gone.sources[0]?.fail(2)
    await Bun.sleep(60)
    expect(gone.checks()).toBe(1)
    expect(gone.sources).toHaveLength(1)
  })

  test('повторы подряд — пауза растёт', async () => {
    const flaky = harness()
    stops.push(flaky.stop)
    flaky.sources[0]?.fail(2)
    await Bun.sleep(15) // 5 мс
    flaky.sources[1]?.fail(2)
    await Bun.sleep(5) // теперь пауза 10 мс — ещё рано
    expect(flaky.sources).toHaveLength(2)
    await Bun.sleep(30)
    expect(flaky.sources).toHaveLength(3)
  })
})

describe('буфер живого лога', () => {
  test('повтор хвоста после переподключения отсекается; строка с тем же временем, но новым текстом — нет', () => {
    const buffer = new LogBuffer()
    const at = '2026-11-25T10:00:00.000000000Z'
    expect(buffer.push({ at, text: 'a' })).toBe(true)
    expect(buffer.push({ at: '2026-11-25T10:00:01.000000000Z', text: 'b' })).toBe(true)

    expect(buffer.push({ at, text: 'a' })).toBe(false)
    expect(buffer.push({ at: '2026-11-25T10:00:01.000000000Z', text: 'b' })).toBe(false)
    expect(buffer.push({ at: '2026-11-25T10:00:01.000000000Z', text: 'c' })).toBe(true)
    expect(buffer.all.map((line) => line.text)).toEqual(['a', 'b', 'c'])
  })

  test('держит не больше LOG_LINES_KEPT строк — старые отбрасываются', () => {
    const buffer = new LogBuffer()
    for (let i = 0; i < LOG_LINES_KEPT + 5; i++) buffer.push({ at: `2026-11-25T10:00:00.${String(i).padStart(9, '0')}Z`, text: `${i}` })
    expect(buffer.all).toHaveLength(LOG_LINES_KEPT)
    expect(buffer.all[0]?.text).toBe('5')
  })
})

describe('пропуск в живом логе', () => {
  test('пометка встаёт в ленту и не мешает отсеву повторов; до первой строки — не нужна', () => {
    const buffer = new LogBuffer()
    expect(buffer.mark('gap')).toBe(false)
    buffer.push({ at: '2026-11-25T10:00:00.000000000Z', text: 'a' })
    expect(buffer.mark('gap')).toBe(true)
    expect(buffer.push({ at: '2026-11-25T10:00:00.000000000Z', text: 'a' })).toBe(false)
    expect(buffer.push({ at: '2026-11-25T10:00:05.000000000Z', text: 'b' })).toBe(true)
    expect(buffer.all.map((line) => line.text)).toEqual(['a', 'gap', 'b'])
  })
})

describe('поток живых логов', () => {
  function stream() {
    const events: LogStreamEvent[] = []
    let source: FakeSource | undefined
    const close = openLogStream(
      '/api/deployments/d/logs/stream',
      (event) => events.push(event),
      () => {
        source = new FakeSource()
        return source
      },
    )
    if (!source) throw new Error('not opened')
    return { events, source, close }
  }

  test('открытие не закрывает поток: строки идут и после него, повторы отсекаются, разрыв помечается', () => {
    const { events, source, close } = stream()
    source.open()
    source.emit('log', { at: '2026-11-25T10:00:00.000000000Z', text: 'a' })
    source.emit('log', { at: '2026-11-25T10:00:00.000000000Z', text: 'a' })
    source.emit('logs-gap', {})
    source.emit('log', { at: '2026-11-25T10:00:09.000000000Z', text: 'b' })

    expect(source.closed).toBe(false)
    const last = events.at(-1)
    expect(last?.kind === 'lines' && last.lines.map((line) => line.text)).toEqual(['a', LOG_GAP_TEXT, 'b'])
    expect(events[0]).toEqual({ kind: 'open' })
    close()
    expect(source.closed).toBe(true)
  })

  test('сбой Dokploy — предупреждение, поток живёт; развёртывание удалено или ответ не 200 — поток кончился', () => {
    const first = stream()
    first.source.emit('logs-error', { code: 'LOGS_UNAVAILABLE' })
    expect(first.source.closed).toBe(false)
    first.source.emit('logs-error', { code: 'DEPLOYMENT_NOT_FOUND' })
    expect(first.events.slice(-2)).toEqual([
      { kind: 'warning', code: 'LOGS_UNAVAILABLE' },
      { kind: 'closed', code: 'DEPLOYMENT_NOT_FOUND' },
    ])
    expect(first.source.closed).toBe(true)

    const rejected = stream()
    rejected.source.fail(0) // обрыв — браузер переподключится сам
    expect(rejected.events).toEqual([])
    rejected.source.fail(2)
    expect(rejected.events).toEqual([{ kind: 'closed', code: null }])
  })
})
