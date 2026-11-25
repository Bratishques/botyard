import { afterEach, describe, expect, test } from 'bun:test'
import { connectDeploymentEvents, type EventSourceLike, LOG_LINES_KEPT, LogBuffer } from './live'

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

function harness() {
  const invalidated: { queryKey: readonly unknown[]; exact?: boolean }[] = []
  const sources: FakeSource[] = []
  const stop = connectDeploymentEvents(
    {
      invalidateQueries: async (filters) => {
        invalidated.push(filters)
      },
    },
    () => {
      const source = new FakeSource()
      sources.push(source)
      return source
    },
  )
  return { invalidated, sources, stop }
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

    sources[0]?.emit('deployment', { deploymentId: 'd1' })

    expect(invalidated).toEqual([{ queryKey: ['deployments', 'd1'] }, { queryKey: ['deployments'], exact: true }])
  })

  test('resync и переподключение после обрыва перечитывают всё; первое подключение — нет', () => {
    const { invalidated, sources, stop } = harness()
    stops.push(stop)
    sources[0]?.open()
    expect(invalidated).toEqual([])

    sources[0]?.emit('resync', {})
    sources[0]?.fail(0) // обрыв сети: браузер переподключится сам
    sources[0]?.open()

    expect(invalidated).toEqual([{ queryKey: ['deployments'] }, { queryKey: ['deployments'] }])
    expect(sources).toHaveLength(1)
  })

  test('поток закрыт сервером (401, 429) — новый через паузу; отключение отменяет повтор', async () => {
    const { sources, stop } = harness()
    sources[0]?.fail(2)
    expect(sources).toHaveLength(1)
    stop()
    await Bun.sleep(10)
    expect(sources).toHaveLength(1)
    expect(sources[0]?.closed).toBe(true)
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
