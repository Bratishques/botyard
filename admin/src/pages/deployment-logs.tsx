/**
 * Логи робота на карточке развёртывания: живой поток SSE `GET /deployments/:id/logs/stream`.
 *
 * Поток открывается по кнопке, а не сразу: на оператора сервер держит не больше трёх потоков логов, и открытая
 * карточка не должна занимать один из них без нужды. Токен клиента и ключ Dokploy сервер вычищает сам.
 */
import type { LogLine } from '@botyard/contract'
import { useEffect, useRef, useState } from 'react'
import { LogBuffer } from '../api/live'
import { Button } from '../ui/kit'

type StreamState = { kind: 'off' } | { kind: 'connecting' } | { kind: 'live' } | { kind: 'closed'; reason: string }

/** Код ошибки потока → текст для оператора */
const ERRORS: Record<string, string> = {
  DEPLOYMENT_NOT_FOUND: 'развёртывание удалено',
  LOGS_UNAVAILABLE: 'Dokploy не отдал логи, следующая попытка через несколько секунд',
}

export function DeploymentLogs({ deploymentId }: { deploymentId: string }) {
  const [state, setState] = useState<StreamState>({ kind: 'off' })
  const [lines, setLines] = useState<readonly LogLine[]>([])
  const [warning, setWarning] = useState<string | null>(null)
  const bottom = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (state.kind !== 'connecting') return
    const buffer = new LogBuffer()
    const source = new EventSource(`/api/deployments/${encodeURIComponent(deploymentId)}/logs/stream`)
    source.onopen = () => setState({ kind: 'live' })
    source.addEventListener('log', (event) => {
      try {
        if (buffer.push(JSON.parse(event.data) as LogLine)) setLines(buffer.all)
        setWarning(null)
      } catch {
        // Битое событие — пропустить, поток живёт
      }
    })
    source.addEventListener('logs-gap', () => {
      // Робот печатал быстрее опроса: пропуск видно прямо в ленте, на месте разрыва
      if (buffer.mark('… часть строк пропущена: робот печатал быстрее, чем их успевали читать …')) setLines(buffer.all)
    })
    source.addEventListener('logs-error', (event) => {
      let code = 'LOGS_UNAVAILABLE'
      try {
        code = (JSON.parse(event.data) as { code?: string }).code ?? code
      } catch {}
      if (code === 'DEPLOYMENT_NOT_FOUND') {
        source.close()
        setState({ kind: 'closed', reason: ERRORS[code] ?? code })
      } else {
        setWarning(ERRORS[code] ?? code)
      }
    })
    source.onerror = () => {
      // Обрыв сети браузер переподключает сам (повторы отсечёт буфер); закрытый поток — ответ не 200:
      // сессия кончилась (401) или открыто слишком много потоков (429)
      if (source.readyState === EventSource.CLOSED) {
        setState({ kind: 'closed', reason: 'поток закрыт: сессия кончилась или открыто слишком много потоков логов' })
      }
    }
    return () => source.close()
  }, [state.kind, deploymentId])

  useEffect(() => {
    if (lines.length > 0) bottom.current?.scrollIntoView({ block: 'nearest' })
  }, [lines])

  const running = state.kind === 'connecting' || state.kind === 'live'
  return (
    <section>
      <div className="mb-2 flex items-center gap-3">
        <h2 className="font-semibold">Логи</h2>
        {running ? (
          <Button onClick={() => setState({ kind: 'off' })}>Остановить</Button>
        ) : (
          <Button
            onClick={() => {
              setLines([])
              setWarning(null)
              setState({ kind: 'connecting' })
            }}
          >
            {state.kind === 'off' ? 'Показать живые логи' : 'Открыть снова'}
          </Button>
        )}
        {state.kind === 'connecting' && <span className="text-xs text-slate-500">подключаемся…</span>}
        {state.kind === 'live' && <span className="text-xs text-sky-700">новые строки каждые несколько секунд</span>}
        {state.kind === 'closed' && <span className="text-xs text-red-700">{state.reason}</span>}
        {warning && running && <span className="text-xs text-amber-700">{warning}</span>}
      </div>
      {state.kind !== 'off' && (
        <div className="max-h-96 overflow-auto rounded border border-slate-200 bg-slate-950 p-3 font-mono text-xs text-slate-100">
          {lines.length === 0 ? (
            <span className="text-slate-400">строк пока нет — контейнер ещё не запущен или молчит</span>
          ) : (
            lines.map((line, index) => (
              // Строки только дописываются в конец, а при переполнении сдвигаются целиком — индекс годится
              // biome-ignore lint/suspicious/noArrayIndexKey: append-only список
              <div key={index} className="whitespace-pre-wrap break-all">
                <span className="text-slate-500">{line.at.slice(11, 23)}</span> {line.text}
              </div>
            ))
          )}
          <div ref={bottom} />
        </div>
      )}
    </section>
  )
}
