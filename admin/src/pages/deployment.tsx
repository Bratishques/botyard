/**
 * Карточка развёртывания: статус, текущая операция, история операций и действия start/stop/redeploy/delete.
 *
 * - Статус — только подтверждённый сервером: после действия карточка перечитывается, а пока идёт операция —
 *   опрашивается (`api/live.ts`, шов для SSE).
 * - Каждое действие — диалог подтверждения: открытие диалога начинает попытку (свой `Idempotency-Key`) и фиксирует
 *   `version`, которую видел оператор. Повтор в том же диалоге уходит с тем же ключом и телом.
 * - Доступность кнопок — подсказка по правилам API (из каких статусов что можно); решает всё равно сервер.
 */
import { type DeploymentAction, type DeploymentDetailsView, type DeploymentStatus } from '@botyard/contract'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { needsRefetch } from '../api/errors'
import { useAttempt } from '../api/idempotency'
import { api } from '../api/index'
import { isBusy } from '../api/live'
import { deploymentQuery, queryKeys } from '../api/queries'
import { Badge, Button, Dialog, ErrorBox, Fact, Facts, formatTime, Loading, PageHeader, Table, Td } from '../ui/kit'
import { useNames } from './deployments'

const ACTIONS: readonly DeploymentAction[] = ['start', 'stop', 'redeploy', 'delete']

/** Из каких статусов API принимает действие (api/docs/api-contract.md, «Развёртывания») */
const ALLOWED_FROM: Record<DeploymentAction, readonly DeploymentStatus[]> = {
  start: ['STOPPED'],
  stop: ['RUNNING', 'FAILED'],
  redeploy: ['RUNNING', 'STOPPED', 'FAILED'],
  delete: ['PROVISIONING', 'RUNNING', 'STOPPED', 'FAILED', 'DELETING'],
}

const ACTION_LABELS: Record<DeploymentAction, { title: string; text: string }> = {
  start: { title: 'Запустить', text: 'Робот запустится на назначении.' },
  stop: { title: 'Остановить', text: 'Робот остановится и перестанет торговать.' },
  redeploy: { title: 'Пересобрать', text: 'Образ соберётся заново из исходников шаблона, робот перезапустится.' },
  delete: { title: 'Удалить', text: 'Приложение робота удалится из Dokploy. Отменить нельзя.' },
}

export function DeploymentPage({ id }: { id: string }) {
  const deployment = useQuery(deploymentQuery(id))
  const names = useNames()
  const [action, setAction] = useState<DeploymentAction | null>(null)

  if (deployment.error && !deployment.data) return <ErrorBox error={deployment.error} />
  if (!deployment.data) return <Loading />
  const d = deployment.data
  const busy = isBusy(d)
  const active = d.operations.find((op) => op.id === d.activeOperationId)

  return (
    <div className="space-y-6">
      <PageHeader title={d.appName}>
        {ACTIONS.map((a) => (
          <Button
            key={a}
            variant={a === 'delete' ? 'danger' : 'secondary'}
            // Во время операции API ответит DEPLOYMENT_OPERATION_IN_PROGRESS. Упавшее удаление оставляет DELETING
            // без активной операции — тогда delete снова доступен (повтор удаления)
            disabled={!ALLOWED_FROM[a].includes(d.status) || d.activeOperationId !== null}
            onClick={() => setAction(a)}
          >
            {ACTION_LABELS[a].title}
          </Button>
        ))}
      </PageHeader>
      {/* Ошибка фонового опроса не прячет последние подтверждённые данные */}
      <ErrorBox error={deployment.error} />

      <section className="rounded border border-slate-200 bg-white p-4">
        <Facts>
          <Fact label="Статус">
            <span className="flex items-center gap-2">
              <Badge value={d.status} />
              {busy && <span className="text-xs text-sky-700">обновляется каждые несколько секунд…</span>}
            </span>
          </Fact>
          <Fact label="Режим торговли">
            <Badge value={d.tradingMode} />
          </Fact>
          <Fact label="Клиент">{names.customer(d.customerId)}</Fact>
          <Fact label="Назначение">{names.destination(d.destinationId)}</Fact>
          <Fact label="Робот">
            <Link to="/templates/$templateId" params={{ templateId: d.templateId }} className="text-sky-700 hover:underline">
              {d.templateId}
            </Link>
          </Fact>
          <Fact label="Версия шаблона">
            <span className="font-mono text-xs">{d.templateVersion}</span>
          </Fact>
          <Fact label="Последняя ошибка">{d.lastError ?? '—'}</Fact>
          <Fact label="Создано">{formatTime(d.createdAt)}</Fact>
          <Fact label="Изменено">{formatTime(d.updatedAt)}</Fact>
          <Fact label="id">
            <span className="font-mono text-xs">{d.id}</span>
          </Fact>
        </Facts>
      </section>

      {active && (
        <section className="rounded border border-sky-200 bg-sky-50 p-4 text-sm">
          <h2 className="mb-1 font-semibold">Текущая операция</h2>
          {active.kind} · <Badge value={active.status} /> · шаг <span className="font-mono">{active.step ?? '—'}</span> · попытка{' '}
          {active.attempt}
        </section>
      )}

      <section>
        <h2 className="mb-2 font-semibold">Операции</h2>
        <Operations deployment={d} />
      </section>

      <section>
        <h2 className="mb-2 font-semibold">Конфиг</h2>
        <pre className="overflow-x-auto rounded border border-slate-200 bg-white p-3 text-xs">{JSON.stringify(d.config, null, 2)}</pre>
      </section>

      {action && <ActionDialog deployment={d} action={action} onClose={() => setAction(null)} />}
    </div>
  )
}

function Operations({ deployment }: { deployment: DeploymentDetailsView }) {
  return (
    <Table head={['Операция', 'Статус', 'Шаг', 'Попытка', 'Ошибка', 'Начата', 'Завершена']}>
      {deployment.operations.map((op) => (
        <tr key={op.id}>
          <Td className="font-medium">{op.kind}</Td>
          <Td>
            <Badge value={op.status} />
          </Td>
          <Td className="font-mono text-xs">{op.step ?? '—'}</Td>
          <Td>{op.attempt}</Td>
          {/* error операции — причина отказа без секретов, как её записал воркер саги */}
          <Td className="max-w-xs break-words text-xs text-red-700">{op.error ?? ''}</Td>
          <Td className="text-xs">{formatTime(op.createdAt)}</Td>
          <Td className="text-xs">{formatTime(op.finishedAt)}</Td>
        </tr>
      ))}
    </Table>
  )
}

function ActionDialog({
  deployment,
  action,
  onClose,
}: {
  deployment: DeploymentDetailsView
  action: DeploymentAction
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const attempt = useAttempt()
  // Тело попытки фиксируется при открытии: тот же ключ с другим телом API отверг бы как IDEMPOTENCY_CONFLICT
  const [version] = useState(deployment.version)
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.deployment(deployment.id) })
    void queryClient.invalidateQueries({ queryKey: queryKeys.deployments })
  }
  const run = useMutation({
    mutationFn: () => attempt.run((key) => api.deployments.act(deployment.id, action, { version }, key)),
    onSuccess: () => {
      // Ответ — принятая операция, а не результат. Его не кладём в кеш: при повторе с тем же ключом API вернёт
      // сохранённый прежний ответ с устаревшим статусом. Перечитываем карточку, дальше её ведёт опрос
      refresh()
      onClose()
    },
    onError: (error) => {
      if (needsRefetch(error)) refresh()
    },
  })
  const label = ACTION_LABELS[action]
  return (
    <Dialog title={`${label.title}: ${deployment.appName}`} onClose={onClose} locked={run.isPending}>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault()
          run.mutate()
        }}
      >
        <p className="text-sm text-slate-600">{label.text}</p>
        {deployment.tradingMode === 'live' && (
          <p className="text-sm font-medium text-red-700">Боевой режим: робот торгует реальными деньгами.</p>
        )}
        <ErrorBox error={run.error} />
        {run.error !== null && (
          <p className="text-xs text-slate-500">
            Повтор из этого окна уйдёт с тем же ключом: если первый запрос прошёл, вторая операция не появится.
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Закрыть</Button>
          <Button type="submit" variant={action === 'delete' ? 'danger' : 'primary'} disabled={run.isPending}>
            {run.isPending ? 'Отправляем…' : run.error ? 'Повторить' : label.title}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
