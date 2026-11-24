/** Общие элементы интерфейса: кнопки, поля, ошибки, диалог, бейджи. Без библиотеки компонентов — их немного */
import { type ComponentProps, type ReactNode, useEffect, useId, useRef } from 'react'
import { errorMessage } from '../api/errors'

type Variant = 'primary' | 'secondary' | 'danger'

const variants: Record<Variant, string> = {
  primary: 'bg-sky-700 text-white hover:bg-sky-800',
  secondary: 'border border-slate-300 bg-white hover:bg-slate-100',
  danger: 'bg-red-700 text-white hover:bg-red-800',
}

export function Button({
  variant = 'secondary',
  className = '',
  type = 'button',
  ...props
}: ComponentProps<'button'> & { variant?: Variant }) {
  return (
    <button
      type={type}
      className={`rounded px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 ${variants[variant]} ${className}`}
      {...props}
    />
  )
}

/** Ошибка API по коду. Сырой текст ответа не показывается никогда (см. `errorMessage`) */
export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null
  return (
    <div role="alert" className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
      {errorMessage(error)}
    </div>
  )
}

export const inputClass =
  'w-full rounded border border-slate-300 bg-white px-2 py-1 text-sm focus:border-sky-500 focus:outline-none disabled:bg-slate-100'

interface FieldProps {
  label: string
  error?: string
  hint?: ReactNode
  children: (id: string) => ReactNode
}

/** Подпись, поле и ошибка проверки формы. Поле получает id для связи с подписью */
export function Field({ label, error, hint, children }: FieldProps) {
  const id = useId()
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium">
        {label}
      </label>
      {children(id)}
      {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
      {error && (
        <p role="alert" className="mt-1 text-xs text-red-600">
          {error}
        </p>
      )}
    </div>
  )
}

interface DialogProps {
  title: string
  onClose: () => void
  /** Запрос в пути: закрыть нельзя, иначе повторное открытие начнёт новую попытку с новым ключом */
  locked?: boolean
  children: ReactNode
}

/**
 * Модальный диалог на `<dialog>`. Родитель монтирует его только открытым: так всё состояние внутри, в том числе
 * ключ идемпотентности попытки, рождается при открытии и умирает при закрытии.
 */
export function Dialog({ title, onClose, locked = false, children }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current
    if (dialog && !dialog.open) dialog.showModal()
  }, [])
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={(event) => {
        if (locked) event.preventDefault()
      }}
      className="m-auto w-full max-w-lg rounded-lg p-0 shadow-xl backdrop:bg-slate-900/40"
      aria-labelledby="dialog-title"
    >
      <div className="space-y-4 p-5">
        <div className="flex items-start justify-between gap-4">
          <h2 id="dialog-title" className="text-lg font-semibold">
            {title}
          </h2>
          <button type="button" className="text-slate-500 hover:text-slate-900" onClick={onClose} disabled={locked} aria-label="Закрыть">
            ✕
          </button>
        </div>
        {children}
      </div>
    </dialog>
  )
}

const statusColors: Record<string, string> = {
  ACTIVE: 'bg-green-100 text-green-800',
  RUNNING: 'bg-green-100 text-green-800',
  SUCCEEDED: 'bg-green-100 text-green-800',
  UNREACHABLE: 'bg-amber-100 text-amber-800',
  PROVISIONING: 'bg-sky-100 text-sky-800',
  DELETING: 'bg-sky-100 text-sky-800',
  PENDING: 'bg-sky-100 text-sky-800',
  FAILED: 'bg-red-100 text-red-800',
  live: 'bg-red-100 text-red-800',
  sandbox: 'bg-slate-100 text-slate-700',
}

export function Badge({ value }: { value: string }) {
  return (
    <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${statusColors[value] ?? 'bg-slate-100 text-slate-700'}`}>{value}</span>
  )
}

export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mb-4 flex items-center justify-between gap-4">
      <h1 className="text-xl font-semibold">{title}</h1>
      <div className="flex gap-2">{children}</div>
    </div>
  )
}

export function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded border border-slate-200 bg-white">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase text-slate-500">
          <tr>
            {head.map((h) => (
              <th key={h} className="px-3 py-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">{children}</tbody>
      </table>
    </div>
  )
}

export function Td({ children, className = '' }: { children?: ReactNode; className?: string }) {
  return <td className={`px-3 py-2 align-top ${className}`}>{children}</td>
}

export function Loading() {
  return <p className="text-sm text-slate-500">Загрузка…</p>
}

export function formatTime(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString('ru-RU') : '—'
}

/** Пары «подпись — значение» для карточек деталей */
export function Facts({ children }: { children: ReactNode }) {
  return <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">{children}</dl>
}

export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-slate-500">{label}</dt>
      <dd className="break-all">{children}</dd>
    </>
  )
}
