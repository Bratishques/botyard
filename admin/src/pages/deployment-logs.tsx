/**
 * Логи робота на карточке развёртывания: живой поток SSE `GET /deployments/:id/logs/stream`.
 *
 * Поток открывается по кнопке, а не сразу: на оператора сервер держит не больше трёх потоков логов, и открытая
 * карточка не должна занимать один из них без нужды. Токен клиента и ключ Dokploy сервер вычищает сам.
 *
 * Эффект зависит только от «включено» и id: фаза потока (подключается, идёт, закрыт) — отдельное состояние, её
 * смена поток не пересоздаёт и не закрывает.
 */
import type { LogLine } from '@botyard/contract'
import { useEffect, useRef, useState } from 'react'
import { codeMessage, errorMessage } from '../api/errors'
import { api } from '../api/index'
import { openLogStream } from '../api/live'
import { Button } from '../ui/kit'

type Phase = { kind: 'connecting' } | { kind: 'live' } | { kind: 'closed'; reason: string }

const WARNINGS: Record<string, string> = {
  LOGS_UNAVAILABLE: 'Dokploy не отдал логи, следующая попытка через несколько секунд',
}

export function DeploymentLogs({ deploymentId }: { deploymentId: string }) {
  // Сеанс потока: `null` — выключен; новое значение — новый поток (в том числе «открыть снова» после закрытия)
  const [session, setSession] = useState<number | null>(null)
  const enabled = session !== null
  const [phase, setPhase] = useState<Phase>({ kind: 'connecting' })
  const [lines, setLines] = useState<readonly LogLine[]>([])
  const [warning, setWarning] = useState<string | null>(null)
  const bottom = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (session === null) return
    setPhase({ kind: 'connecting' })
    setLines([])
    setWarning(null)
    let active = true
    const close = openLogStream(`/api/deployments/${encodeURIComponent(deploymentId)}/logs/stream`, (event) => {
      if (!active) return
      switch (event.kind) {
        case 'open':
          setPhase({ kind: 'live' })
          return
        case 'lines':
          setLines(event.lines)
          setWarning(null)
          return
        case 'warning':
          setWarning(WARNINGS[event.code] ?? event.code)
          return
        case 'closed':
          if (event.code) {
            setPhase({ kind: 'closed', reason: codeMessage(event.code) })
            return
          }
          // Ответ не 200 — EventSource его не показывает: узнать причину обычным запросом (401 сам уведёт на вход)
          setPhase({ kind: 'closed', reason: 'поток закрыт' })
          void api.deployments.logs(deploymentId, 1).then(
            // Логи читаются — значит, поток отклонён пределом потоков
            () => active && setPhase({ kind: 'closed', reason: codeMessage('TOO_MANY_STREAMS') }),
            (error: unknown) => active && setPhase({ kind: 'closed', reason: errorMessage(error) }),
          )
      }
    })
    return () => {
      active = false
      close()
    }
  }, [session, deploymentId])

  useEffect(() => {
    if (lines.length > 0) bottom.current?.scrollIntoView({ block: 'nearest' })
  }, [lines])

  const running = enabled && phase.kind !== 'closed'
  return (
    <section>
      <div className="mb-2 flex flex-wrap items-center gap-3">
        <h2 className="font-semibold">Логи</h2>
        {running ? (
          <Button onClick={() => setSession(null)}>Остановить</Button>
        ) : (
          <Button onClick={() => setSession((previous) => (previous ?? 0) + 1)}>{enabled ? 'Открыть снова' : 'Показать живые логи'}</Button>
        )}
        {enabled && phase.kind === 'connecting' && <span className="text-xs text-slate-500">подключаемся…</span>}
        {enabled && phase.kind === 'live' && <span className="text-xs text-sky-700">новые строки каждые несколько секунд</span>}
        {enabled && phase.kind === 'closed' && <span className="text-xs text-red-700">{phase.reason}</span>}
        {warning && running && <span className="text-xs text-amber-700">{warning}</span>}
      </div>
      {enabled && (
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
