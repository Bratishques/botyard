/**
 * Клиенты. Токен T-Invest только вводится: в ответах — подсказка `tokenHint`. Клиент создаётся в песочнице;
 * боевой режим — отдельный диалог с вводом точного имени клиента (admin/AGENTS.md), смена счёта боевого
 * клиента — тоже с подтверждением именем (иначе API ответит `CUSTOMER_LIVE_CONFIRMATION_REQUIRED`).
 * Версия в каждом диалоге — та, что видел оператор при открытии: чужая правка даст конфликт, а не перезапись.
 */
import {
  type CustomerUpdateBody,
  type CustomerView,
  customerCreateSchema,
  customerLiveSchema,
  customerSandboxSchema,
  customerTokenSchema,
  customerUpdateSchema,
} from '@botyard/contract'
import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useState } from 'react'
import { type UseFormRegisterReturn, useForm } from 'react-hook-form'
import { z } from 'zod'
import { needsRefetch } from '../api/errors'
import { api } from '../api/index'
import { customersQuery, queryKeys } from '../api/queries'
import { Badge, Button, Dialog, ErrorBox, Field, formatTime, inputClass, Loading, PageHeader, Table, Td } from '../ui/kit'

type DialogKind = 'edit' | 'token' | 'live' | 'sandbox' | 'archive'

export function CustomersPage() {
  const list = useQuery(customersQuery)
  const [creating, setCreating] = useState(false)
  const [open, setOpen] = useState<{ kind: DialogKind; customer: CustomerView } | null>(null)
  const close = () => setOpen(null)

  return (
    <div>
      <PageHeader title="Клиенты">
        <Button variant="primary" onClick={() => setCreating(true)}>
          Добавить
        </Button>
      </PageHeader>
      <ErrorBox error={list.error} />
      {list.isPending ? (
        <Loading />
      ) : (
        <Table head={['Имя', 'Счёт', 'Токен', 'Режим', 'Статус', 'Изменён', '']}>
          {list.data?.map((c) => (
            <tr key={c.id}>
              <Td className="font-medium">{c.name}</Td>
              <Td className="font-mono text-xs">{c.accountId}</Td>
              <Td className="font-mono">{c.tokenHint}</Td>
              <Td>
                <Badge value={c.mode} />
              </Td>
              <Td>
                <Badge value={c.status} />
              </Td>
              <Td className="text-xs">{formatTime(c.updatedAt)}</Td>
              <Td>
                {c.status === 'ACTIVE' && (
                  <div className="flex flex-wrap gap-1">
                    <Button onClick={() => setOpen({ kind: 'edit', customer: c })}>Изменить</Button>
                    <Button onClick={() => setOpen({ kind: 'token', customer: c })}>Токен</Button>
                    {c.mode === 'sandbox' ? (
                      <Button variant="danger" onClick={() => setOpen({ kind: 'live', customer: c })}>
                        В боевой
                      </Button>
                    ) : (
                      <Button onClick={() => setOpen({ kind: 'sandbox', customer: c })}>В песочницу</Button>
                    )}
                    <Button onClick={() => setOpen({ kind: 'archive', customer: c })}>В архив</Button>
                  </div>
                )}
              </Td>
            </tr>
          ))}
        </Table>
      )}
      {list.data?.length === 0 && <p className="mt-3 text-sm text-slate-500">Клиентов пока нет.</p>}
      {creating && <CreateCustomerDialog onClose={() => setCreating(false)} />}
      {open?.kind === 'edit' && <EditCustomerDialog customer={open.customer} onClose={close} />}
      {open?.kind === 'token' && <TokenDialog customer={open.customer} onClose={close} />}
      {open?.kind === 'live' && <LiveDialog customer={open.customer} onClose={close} />}
      {open?.kind === 'sandbox' && <SandboxDialog customer={open.customer} onClose={close} />}
      {open?.kind === 'archive' && <ArchiveDialog customer={open.customer} onClose={close} />}
    </div>
  )
}

/** Мутация клиента: успех закрывает диалог, конфликт перечитывает список — оба обновляют показанные данные */
function useCustomerMutation<B>(send: (body: B) => Promise<CustomerView>, onClose: () => void) {
  const queryClient = useQueryClient()
  const invalidate = () => queryClient.invalidateQueries({ queryKey: queryKeys.customers })
  return useMutation({
    mutationFn: send,
    onSuccess: () => {
      void invalidate()
      onClose()
    },
    onError: (error) => {
      if (needsRefetch(error)) void invalidate()
    },
  })
}

function Actions({
  onClose,
  pending,
  label,
  danger,
  disabled,
}: {
  onClose: () => void
  pending: boolean
  label: string
  danger?: boolean
  disabled?: boolean
}) {
  return (
    <div className="flex justify-end gap-2">
      <Button onClick={onClose}>Отмена</Button>
      <Button type="submit" variant={danger ? 'danger' : 'primary'} disabled={pending || disabled}>
        {pending ? 'Отправляем…' : label}
      </Button>
    </div>
  )
}

function TokenInput({ id, registration }: { id: string; registration: UseFormRegisterReturn }) {
  return <input id={id} type="password" autoComplete="off" className={`${inputClass} font-mono`} {...registration} />
}

const TOKEN_ERROR = 'Токен — не короче 16 печатных символов без пробелов'

// Форма сужает контракт (непустые имя и счёт), но не ослабляет
const createFormSchema = customerCreateSchema.extend({
  name: customerCreateSchema.shape.name.min(1),
  accountId: customerCreateSchema.shape.accountId.min(1),
})

function CreateCustomerDialog({ onClose }: { onClose: () => void }) {
  const form = useForm<z.input<typeof createFormSchema>, unknown, z.output<typeof createFormSchema>>({
    resolver: zodResolver(createFormSchema),
    defaultValues: { name: '', accountId: '', token: '' },
  })
  const create = useCustomerMutation(api.customers.create, onClose)
  const errors = form.formState.errors
  return (
    <Dialog title="Новый клиент (песочница)" onClose={onClose}>
      <form className="space-y-3" onSubmit={form.handleSubmit((body) => create.mutate(body))} noValidate>
        <Field label="Имя" error={errors.name && 'Введите имя'}>
          {(id) => <input id={id} className={inputClass} {...form.register('name')} />}
        </Field>
        <Field label="Счёт песочницы" error={errors.accountId && 'Введите счёт'}>
          {(id) => <input id={id} className={`${inputClass} font-mono`} {...form.register('accountId')} />}
        </Field>
        <Field label="Токен песочницы T-Invest" error={errors.token && TOKEN_ERROR} hint="Проверяется у T-Invest и обратно не показывается">
          {(id) => <TokenInput id={id} registration={form.register('token')} />}
        </Field>
        <ErrorBox error={create.error} />
        <Actions onClose={onClose} pending={create.isPending} label="Создать" />
      </form>
    </Dialog>
  )
}

// Правка: поля те же, что в контракте, но имя и счёт не пустые; в тело уходят только изменённые
const editFormSchema = z.object({
  name: customerUpdateSchema.shape.name.unwrap().min(1),
  accountId: customerUpdateSchema.shape.accountId.unwrap().min(1),
  confirmName: z.string(),
})

function EditCustomerDialog({ customer: c, onClose }: { customer: CustomerView; onClose: () => void }) {
  const [version] = useState(c.version)
  const form = useForm<z.input<typeof editFormSchema>, unknown, z.output<typeof editFormSchema>>({
    resolver: zodResolver(editFormSchema),
    defaultValues: { name: c.name, accountId: c.accountId, confirmName: '' },
  })
  const update = useCustomerMutation((body: CustomerUpdateBody) => api.customers.update(c.id, body), onClose)
  const accountId = form.watch('accountId')
  // Смена счёта боевого клиента ведёт деньги на другой счёт: API требует подтверждение точным именем
  const needsConfirm = c.mode === 'live' && accountId !== c.accountId
  const confirmed = !needsConfirm || form.watch('confirmName') === c.name

  const submit = form.handleSubmit((values) => {
    const body: CustomerUpdateBody = { version }
    if (values.name !== c.name) body.name = values.name
    if (values.accountId !== c.accountId) body.accountId = values.accountId
    if (needsConfirm) body.confirmName = values.confirmName
    update.mutate(body)
  })

  return (
    <Dialog title={`Клиент ${c.name}`} onClose={onClose}>
      <form className="space-y-3" onSubmit={submit} noValidate>
        <Field label="Имя" error={form.formState.errors.name && 'Введите имя'}>
          {(id) => <input id={id} className={inputClass} {...form.register('name')} />}
        </Field>
        <Field
          label={c.mode === 'live' ? 'Боевой счёт' : 'Счёт песочницы'}
          error={form.formState.errors.accountId && 'Введите счёт'}
          hint="Счёт проверяется у T-Invest токеном клиента"
        >
          {(id) => <input id={id} className={`${inputClass} font-mono`} {...form.register('accountId')} />}
        </Field>
        {needsConfirm && (
          <ConfirmName name={c.name}>
            {(id) => <input id={id} autoComplete="off" className={inputClass} {...form.register('confirmName')} />}
          </ConfirmName>
        )}
        <ErrorBox error={update.error} />
        <Actions onClose={onClose} pending={update.isPending} label="Сохранить" disabled={!confirmed} />
      </form>
    </Dialog>
  )
}

function ConfirmName({ name, children }: { name: string; children: (id: string) => ReactNode }) {
  return (
    <div className="rounded border border-red-200 bg-red-50 p-3">
      <Field
        label="Подтверждение: введите имя клиента"
        hint={
          <>
            Точно как в карточке: <span className="font-mono">{name}</span>
          </>
        }
      >
        {children}
      </Field>
    </div>
  )
}

const tokenFormSchema = customerTokenSchema.omit({ version: true })

function TokenDialog({ customer: c, onClose }: { customer: CustomerView; onClose: () => void }) {
  const [version] = useState(c.version)
  const form = useForm<z.input<typeof tokenFormSchema>, unknown, z.output<typeof tokenFormSchema>>({
    resolver: zodResolver(tokenFormSchema),
    defaultValues: { token: '' },
  })
  const rotate = useCustomerMutation((token: string) => api.customers.rotateToken(c.id, { version, token }), onClose)
  return (
    <Dialog title={`Новый токен: ${c.name}`} onClose={onClose}>
      <form className="space-y-3" onSubmit={form.handleSubmit(({ token }) => rotate.mutate(token))} noValidate>
        <p className="text-sm text-slate-600">
          Токен того же режима ({c.mode === 'live' ? 'боевой' : 'песочница'}). Сейчас: <span className="font-mono">{c.tokenHint}</span>.
          Запущенные роботы получат новый токен только после redeploy.
        </p>
        <Field label="Токен T-Invest" error={form.formState.errors.token && TOKEN_ERROR}>
          {(id) => <TokenInput id={id} registration={form.register('token')} />}
        </Field>
        <ErrorBox error={rotate.error} />
        <Actions onClose={onClose} pending={rotate.isPending} label="Сменить токен" />
      </form>
    </Dialog>
  )
}

/** Боевой режим: подтверждение — точное имя клиента, кнопка недоступна до совпадения */
function LiveDialog({ customer: c, onClose }: { customer: CustomerView; onClose: () => void }) {
  const [version] = useState(c.version)
  // Подтверждение сверяется с именем, которое оператор видел при открытии; сервер сверит со своим
  const [schema] = useState(() =>
    customerLiveSchema
      .omit({ version: true })
      .refine((body) => body.confirmName === c.name, { path: ['confirmName'], message: 'Имя не совпадает' }),
  )
  const form = useForm<z.input<typeof schema>, unknown, z.output<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: { token: '', accountId: '', confirmName: '' },
  })
  const goLive = useCustomerMutation((body: z.output<typeof schema>) => api.customers.goLive(c.id, { version, ...body }), onClose)
  const confirmed = form.watch('confirmName') === c.name
  const errors = form.formState.errors
  return (
    <Dialog title={`Боевой режим: ${c.name}`} onClose={onClose}>
      <form className="space-y-3" onSubmit={form.handleSubmit((body) => goLive.mutate(body))} noValidate>
        <p className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-900">
          Роботы клиента будут торговать реальными деньгами. Нужен боевой токен с правом торговли и боевой счёт — счета песочницы и боевые
          разные.
        </p>
        <Field label="Боевой токен T-Invest" error={errors.token && TOKEN_ERROR}>
          {(id) => <TokenInput id={id} registration={form.register('token')} />}
        </Field>
        <Field label="Боевой счёт" error={errors.accountId && 'Введите счёт'}>
          {(id) => <input id={id} className={`${inputClass} font-mono`} {...form.register('accountId')} />}
        </Field>
        <ConfirmName name={c.name}>
          {(id) => <input id={id} autoComplete="off" className={inputClass} {...form.register('confirmName')} />}
        </ConfirmName>
        <ErrorBox error={goLive.error} />
        <Actions onClose={onClose} pending={goLive.isPending} label="Включить боевой режим" danger disabled={!confirmed} />
      </form>
    </Dialog>
  )
}

const sandboxFormSchema = customerSandboxSchema.omit({ version: true })

function SandboxDialog({ customer: c, onClose }: { customer: CustomerView; onClose: () => void }) {
  const [version] = useState(c.version)
  const form = useForm<z.input<typeof sandboxFormSchema>, unknown, z.output<typeof sandboxFormSchema>>({
    resolver: zodResolver(sandboxFormSchema),
    defaultValues: { token: '', accountId: '' },
  })
  const toSandbox = useCustomerMutation(
    (body: z.output<typeof sandboxFormSchema>) => api.customers.toSandbox(c.id, { version, ...body }),
    onClose,
  )
  const errors = form.formState.errors
  return (
    <Dialog title={`В песочницу: ${c.name}`} onClose={onClose}>
      <form className="space-y-3" onSubmit={form.handleSubmit((body) => toSandbox.mutate(body))} noValidate>
        <Field label="Токен песочницы T-Invest" error={errors.token && TOKEN_ERROR}>
          {(id) => <TokenInput id={id} registration={form.register('token')} />}
        </Field>
        <Field label="Счёт песочницы" error={errors.accountId && 'Введите счёт'}>
          {(id) => <input id={id} className={`${inputClass} font-mono`} {...form.register('accountId')} />}
        </Field>
        <ErrorBox error={toSandbox.error} />
        <Actions onClose={onClose} pending={toSandbox.isPending} label="Перевести в песочницу" />
      </form>
    </Dialog>
  )
}

function ArchiveDialog({ customer: c, onClose }: { customer: CustomerView; onClose: () => void }) {
  const [version] = useState(c.version)
  const archive = useCustomerMutation(() => api.customers.archive(c.id, { version }), onClose)
  return (
    <Dialog title={`В архив: ${c.name}`} onClose={onClose}>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault()
          archive.mutate(undefined)
        }}
      >
        <p className="text-sm text-slate-600">
          Разархивации нет, имя архивного клиента останется занятым. Клиента с неудалёнными роботами архивировать нельзя.
        </p>
        <ErrorBox error={archive.error} />
        <Actions onClose={onClose} pending={archive.isPending} label="В архив" danger />
      </form>
    </Dialog>
  )
}
