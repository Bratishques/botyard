/**
 * Назначения — Dokploy-инстансы. API-ключ только вводится: в ответах API его нет, показывается подсказка
 * `apiKeyHint`. Удаления нет: назначение выключается, на него ссылаются развёртывания.
 */
import {
  type DestinationPreviewView,
  type DestinationUpdateBody,
  type DestinationView,
  destinationCreateSchema,
  destinationPreviewSchema,
  destinationUpdateSchema,
} from '@botyard/contract'
import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { type UseFormRegisterReturn, useForm } from 'react-hook-form'
import { z } from 'zod'
import { needsRefetch } from '../api/errors'
import { api } from '../api/index'
import { destinationsQuery, queryKeys } from '../api/queries'
import { Badge, Button, Dialog, ErrorBox, Field, formatTime, inputClass, Loading, PageHeader, Table, Td } from '../ui/kit'

function useInvalidateDestinations() {
  const queryClient = useQueryClient()
  return () => queryClient.invalidateQueries({ queryKey: queryKeys.destinations })
}

export function DestinationsPage() {
  const list = useQuery(destinationsQuery)
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<DestinationView | null>(null)

  return (
    <div>
      <PageHeader title="Назначения">
        <Button variant="primary" onClick={() => setCreating(true)}>
          Добавить
        </Button>
      </PageHeader>
      <ErrorBox error={list.error} />
      {list.isPending ? (
        <Loading />
      ) : (
        <Table head={['Имя', 'Dokploy', 'Ключ', 'Окружение', 'Статус', 'Проверено', '']}>
          {list.data?.map((d) => (
            <DestinationRow key={d.id} destination={d} onEdit={() => setEditing(d)} />
          ))}
        </Table>
      )}
      {list.data?.length === 0 && <p className="mt-3 text-sm text-slate-500">Назначений пока нет.</p>}
      {creating && <CreateDestinationDialog onClose={() => setCreating(false)} />}
      {editing && <EditDestinationDialog destination={editing} onClose={() => setEditing(null)} />}
    </div>
  )
}

function DestinationRow({ destination: d, onEdit }: { destination: DestinationView; onEdit: () => void }) {
  const invalidate = useInvalidateDestinations()
  const action = useMutation({
    mutationFn: (kind: 'check' | 'enable' | 'disable') =>
      kind === 'check' ? api.destinations.check(d.id) : api.destinations[kind](d.id, { version: d.version }),
    // Успех и конфликт одинаково требуют свежих данных: статус показывается только тот, что вернул сервер
    onSettled: () => invalidate(),
  })
  return (
    <tr>
      <Td className="font-medium">{d.name}</Td>
      <Td className="break-all">{d.baseUrl}</Td>
      <Td className="font-mono">{d.apiKeyHint}</Td>
      <Td>
        <div className="font-mono text-xs">{d.environmentId}</div>
        <div className="text-xs text-slate-500">проект {d.projectId}</div>
        {d.serverId && <div className="text-xs text-slate-500">сервер {d.serverId}</div>}
      </Td>
      <Td>
        <Badge value={d.status} />
        {/* lastError — поле назначения (результат проверки связи без секретов), а не message ошибки API: кода у него
            нет, поэтому показываем как есть, как и ошибки операций развёртывания */}
        {d.lastError && <div className="mt-1 max-w-xs break-words text-xs text-red-700">{d.lastError}</div>}
      </Td>
      <Td className="text-xs">{formatTime(d.lastCheckedAt)}</Td>
      <Td>
        <div className="flex flex-wrap gap-1">
          <Button onClick={() => action.mutate('check')} disabled={action.isPending}>
            Проверить
          </Button>
          <Button onClick={onEdit} disabled={action.isPending}>
            Изменить
          </Button>
          {d.status === 'DISABLED' ? (
            <Button onClick={() => action.mutate('enable')} disabled={action.isPending}>
              Включить
            </Button>
          ) : (
            <Button variant="danger" onClick={() => action.mutate('disable')} disabled={action.isPending}>
              Выключить
            </Button>
          )}
        </div>
        {action.error && (
          <div className="mt-1">
            <ErrorBox error={action.error} />
          </div>
        )}
      </Td>
    </tr>
  )
}

/** Окружение и сервер, которые видит ключ: выбор вместо ручного ввода id */
function TargetPicker({
  preview,
  env,
  server,
}: {
  preview: DestinationPreviewView
  env: UseFormRegisterReturn
  server: UseFormRegisterReturn
}) {
  return (
    <>
      <Field label="Окружение Dokploy">
        {(id) => (
          <select id={id} className={inputClass} {...env}>
            <option value="">—</option>
            {preview.environments.map((e) => (
              <option key={e.environmentId} value={e.environmentId}>
                {e.name} ({e.environmentId})
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field label="Сервер" hint="Пусто — сервер самого Dokploy">
        {(id) => (
          <select id={id} className={inputClass} {...server}>
            <option value="">—</option>
            {preview.servers.map((s) => (
              <option key={s.serverId} value={s.serverId}>
                {s.name}
              </option>
            ))}
          </select>
        )}
      </Field>
    </>
  )
}

// Пустой выбор сервера — null (сервер самого Dokploy), как ждёт контракт
const serverIdField = z.preprocess((v) => (v === '' || v === undefined ? null : v), destinationCreateSchema.shape.serverId)
// Форма сужает контракт (непустое имя), но не ослабляет: остальные правила — из `destinationCreateSchema`
const createFormSchema = destinationCreateSchema.extend({ name: destinationCreateSchema.shape.name.min(1), serverId: serverIdField })
type CreateForm = z.input<typeof createFormSchema>

function CreateDestinationDialog({ onClose }: { onClose: () => void }) {
  const invalidate = useInvalidateDestinations()
  const form = useForm<CreateForm, unknown, z.output<typeof createFormSchema>>({
    resolver: zodResolver(createFormSchema),
    defaultValues: { name: '', baseUrl: '', apiKey: '', environmentId: '', serverId: '' },
  })
  const [previewError, setPreviewError] = useState<string | null>(null)
  const preview = useMutation({ mutationFn: api.destinations.preview })
  const create = useMutation({
    mutationFn: api.destinations.create,
    onSuccess: () => {
      void invalidate()
      onClose()
    },
  })

  const loadTargets = () => {
    const parsed = destinationPreviewSchema.safeParse({ baseUrl: form.getValues('baseUrl'), apiKey: form.getValues('apiKey') })
    if (!parsed.success) {
      setPreviewError('Введите адрес и ключ (не короче 16 символов)')
      return
    }
    setPreviewError(null)
    preview.mutate(parsed.data)
  }

  const errors = form.formState.errors
  return (
    <Dialog title="Новое назначение" onClose={onClose}>
      <form className="space-y-3" onSubmit={form.handleSubmit((body) => create.mutate(body))} noValidate>
        <Field label="Имя" error={errors.name && 'Введите имя'}>
          {(id) => <input id={id} className={inputClass} {...form.register('name')} />}
        </Field>
        <Field label="Адрес Dokploy" error={errors.baseUrl && 'Введите адрес'}>
          {(id) => <input id={id} className={inputClass} placeholder="https://dokploy.example.com" {...form.register('baseUrl')} />}
        </Field>
        <Field
          label="API-ключ Dokploy"
          error={errors.apiKey && 'Ключ не короче 16 символов'}
          hint="Уходит на сервер один раз и обратно не показывается"
        >
          {(id) => <input id={id} type="password" autoComplete="off" className={inputClass} {...form.register('apiKey')} />}
        </Field>
        <Button onClick={loadTargets} disabled={preview.isPending}>
          {preview.isPending ? 'Запрашиваем Dokploy…' : 'Получить окружения'}
        </Button>
        {previewError && <p className="text-xs text-red-600">{previewError}</p>}
        <ErrorBox error={preview.error} />
        {preview.data && <TargetPicker preview={preview.data} env={form.register('environmentId')} server={form.register('serverId')} />}
        {errors.environmentId && <p className="text-xs text-red-600">Выберите окружение</p>}
        <ErrorBox error={create.error} />
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Отмена</Button>
          <Button type="submit" variant="primary" disabled={!preview.data || create.isPending}>
            Сохранить
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

// Пустое поле правки — «не менять»: в тело уходят только изменённые поля
const blankToUndefined = (v: unknown) => (v === '' ? undefined : v)
const updateShape = destinationUpdateSchema.shape
const editFormSchema = z.object({
  name: updateShape.name.unwrap().min(1),
  baseUrl: updateShape.baseUrl.unwrap().min(1),
  apiKey: z.preprocess(blankToUndefined, updateShape.apiKey),
  environmentId: updateShape.environmentId.unwrap(),
  serverId: serverIdField,
})
type EditForm = z.input<typeof editFormSchema>

function EditDestinationDialog({ destination: d, onClose }: { destination: DestinationView; onClose: () => void }) {
  const queryClient = useQueryClient()
  // Версия — та, что видел оператор при открытии: чужую правку API отклонит конфликтом, а не перезапишет
  const [version] = useState(d.version)
  const form = useForm<EditForm, unknown, z.output<typeof editFormSchema>>({
    resolver: zodResolver(editFormSchema),
    defaultValues: { name: d.name, baseUrl: d.baseUrl, apiKey: '', environmentId: d.environmentId, serverId: d.serverId ?? '' },
  })
  const preview = useMutation({ mutationFn: api.destinations.preview })
  const update = useMutation({
    mutationFn: (body: DestinationUpdateBody) => api.destinations.update(d.id, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.destinations })
      onClose()
    },
    onError: (error) => {
      if (needsRefetch(error)) void queryClient.invalidateQueries({ queryKey: queryKeys.destinations })
    },
  })

  const submit = form.handleSubmit((values) => {
    const body: DestinationUpdateBody = { version }
    if (values.name !== d.name) body.name = values.name
    if (values.baseUrl !== d.baseUrl) body.baseUrl = values.baseUrl
    if (values.apiKey !== undefined) body.apiKey = values.apiKey
    if (values.environmentId !== d.environmentId) body.environmentId = values.environmentId
    if (values.serverId !== d.serverId) body.serverId = values.serverId
    // Поля уже проверены правилами контракта (editFormSchema собрана из destinationUpdateSchema)
    update.mutate(body)
  })

  const [previewError, setPreviewError] = useState<string | null>(null)
  const loadTargets = () => {
    const parsed = destinationPreviewSchema.safeParse({ baseUrl: form.getValues('baseUrl'), apiKey: form.getValues('apiKey') })
    setPreviewError(parsed.success ? null : 'Для выбора из Dokploy введите новый ключ (не короче 16 символов)')
    if (parsed.success) preview.mutate(parsed.data)
  }

  const errors = form.formState.errors
  return (
    <Dialog title={`Назначение ${d.name}`} onClose={onClose}>
      <form className="space-y-3" onSubmit={submit} noValidate>
        <Field label="Имя" error={errors.name && 'Введите имя'}>
          {(id) => <input id={id} className={inputClass} {...form.register('name')} />}
        </Field>
        <Field label="Адрес Dokploy" error={errors.baseUrl && 'Введите адрес'} hint="Смена адреса требует нового ключа">
          {(id) => <input id={id} className={inputClass} {...form.register('baseUrl')} />}
        </Field>
        <Field
          label="Новый API-ключ"
          error={errors.apiKey && 'Ключ не короче 16 символов'}
          hint={`Сейчас: ${d.apiKeyHint}. Пусто — оставить прежний`}
        >
          {(id) => <input id={id} type="password" autoComplete="off" className={inputClass} {...form.register('apiKey')} />}
        </Field>
        {preview.data ? (
          <TargetPicker preview={preview.data} env={form.register('environmentId')} server={form.register('serverId')} />
        ) : (
          <>
            <Field label="Окружение (id)" error={errors.environmentId && 'Введите окружение'}>
              {(id) => <input id={id} className={`${inputClass} font-mono`} {...form.register('environmentId')} />}
            </Field>
            <Field label="Сервер (id)" hint="Пусто — сервер самого Dokploy">
              {(id) => <input id={id} className={`${inputClass} font-mono`} {...form.register('serverId')} />}
            </Field>
            <Button onClick={loadTargets} disabled={preview.isPending}>
              Выбрать из Dokploy (нужен новый ключ)
            </Button>
            {previewError && <p className="text-xs text-red-600">{previewError}</p>}
          </>
        )}
        <ErrorBox error={preview.error} />
        <ErrorBox error={update.error} />
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Отмена</Button>
          <Button type="submit" variant="primary" disabled={update.isPending}>
            Сохранить
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
