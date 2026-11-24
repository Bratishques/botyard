/**
 * Поле формы по узлу JSON Schema. Работает внутри `FormProvider` react-hook-form: значения и ошибки
 * берёт из контекста, проверку делает резолвер со схемой `formSchema` (см. `schema.ts`).
 */
import { useId } from 'react'
import { type FieldError, get, useFieldArray, useFormContext } from 'react-hook-form'
import { optionLabel, type SchemaNode, toFormValue } from './schema'

interface Props {
  node: SchemaNode
  /** Путь в значениях формы: `config.instruments.0.value.figi` */
  name: string
  label: string
  required: boolean
}

const inputClass = 'w-full rounded border border-slate-300 bg-white px-2 py-1 text-sm focus:border-sky-500 focus:outline-none'

function useFieldError(name: string): string | undefined {
  const { formState } = useFormContext()
  const error: FieldError | undefined = get(formState.errors, name)
  // У массива ошибка размера лежит в `root` (так её кладёт react-hook-form для useFieldArray) или в самом поле
  const rootError: FieldError | undefined = get(formState.errors, `${name}.root`)
  return error?.message ?? rootError?.message
}

function Label({ htmlFor, label, required, description }: { htmlFor?: string; label: string; required: boolean; description?: string }) {
  return (
    <div className="mb-1">
      {htmlFor ? (
        <label htmlFor={htmlFor} className="text-sm font-medium">
          {label}
          {required && <span className="text-red-600"> *</span>}
        </label>
      ) : (
        <span className="text-sm font-medium">
          {label}
          {required && <span className="text-red-600"> *</span>}
        </span>
      )}
      {description && <p className="text-xs text-slate-500">{description}</p>}
    </div>
  )
}

function ErrorLine({ message }: { message?: string }) {
  return message ? (
    <p role="alert" className="mt-1 text-xs text-red-600">
      {message}
    </p>
  ) : null
}

export function SchemaField({ node, name, label, required }: Props) {
  const title = node.title ?? label
  switch (node.kind) {
    case 'object':
      return <ObjectField node={node} name={name} label={title} required={required} />
    case 'array':
      return <ArrayField node={node} name={name} label={title} required={required} />
    case 'boolean':
      return <BooleanField node={node} name={name} label={title} required={required} />
    case 'enum':
      return <EnumField node={node} name={name} label={title} required={required} />
    case 'unsupported':
      return <JsonField node={node} name={name} label={title} required={required} />
    default:
      return <TextField node={node} name={name} label={title} required={required} />
  }
}

function ObjectField({ node, name, label, required }: Props) {
  if (node.kind !== 'object') return null
  return (
    <fieldset className="space-y-3 rounded border border-slate-200 p-3">
      <legend className="px-1 text-sm font-semibold">
        {label}
        {required && <span className="text-red-600"> *</span>}
      </legend>
      {node.description && <p className="text-xs text-slate-500">{node.description}</p>}
      {node.properties.map((p) => (
        <SchemaField key={p.name} node={p.node} name={`${name}.${p.name}`} label={p.name} required={p.required} />
      ))}
    </fieldset>
  )
}

/** Корень конфига: те же поля объекта, но без рамки — рамку даёт форма развёртывания */
export function SchemaFields({ node, name }: { node: SchemaNode; name: string }) {
  if (node.kind !== 'object') return <SchemaField node={node} name={name} label="config" required />
  return (
    <div className="space-y-3">
      {node.properties.map((p) => (
        <SchemaField key={p.name} node={p.node} name={`${name}.${p.name}`} label={p.name} required={p.required} />
      ))}
    </div>
  )
}

function ArrayField({ node, name, label, required }: Props) {
  const { control } = useFormContext()
  const { fields, append, remove } = useFieldArray({ control, name })
  const error = useFieldError(name)
  if (node.kind !== 'array') return null
  const canAdd = node.maxItems === undefined || fields.length < node.maxItems
  return (
    <div>
      <Label label={label} required={required || (node.minItems ?? 0) > 0} description={node.description} />
      <ul className="space-y-2">
        {fields.map((field, index) => (
          <li key={field.id} className="flex items-start gap-2">
            <div className="flex-1">
              <SchemaField node={node.items} name={`${name}.${index}.value`} label={`#${index + 1}`} required />
            </div>
            <button type="button" className="mt-1 text-sm text-red-700 hover:underline" onClick={() => remove(index)}>
              Удалить
            </button>
          </li>
        ))}
      </ul>
      {canAdd && (
        <button
          type="button"
          className="mt-2 text-sm text-sky-700 hover:underline"
          onClick={() => append({ value: toFormValue(node.items) })}
        >
          + Добавить
        </button>
      )}
      <ErrorLine message={error} />
    </div>
  )
}

function TextField({ node, name, label, required }: Props) {
  const id = useId()
  const { register } = useFormContext()
  const error = useFieldError(name)
  const numeric = node.kind === 'number' || node.kind === 'integer'
  return (
    <div>
      <Label htmlFor={id} label={label} required={required} description={node.description} />
      <input
        id={id}
        className={inputClass}
        // Число — текстом: пустое поле должно отличаться от нуля, а проверку делает схема формы
        inputMode={numeric ? (node.kind === 'integer' ? 'numeric' : 'decimal') : undefined}
        aria-invalid={error ? true : undefined}
        {...register(name)}
      />
      <ErrorLine message={error} />
    </div>
  )
}

function BooleanField({ node, name, label }: Props) {
  const id = useId()
  const { register } = useFormContext()
  return (
    <div>
      <div className="flex items-center gap-2">
        <input id={id} type="checkbox" {...register(name)} />
        <label htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
      </div>
      {node.description && <p className="text-xs text-slate-500">{node.description}</p>}
    </div>
  )
}

function EnumField({ node, name, label, required }: Props) {
  const id = useId()
  const { register } = useFormContext()
  const error = useFieldError(name)
  if (node.kind !== 'enum') return null
  return (
    <div>
      <Label htmlFor={id} label={label} required={required} description={node.description} />
      <select id={id} className={inputClass} aria-invalid={error ? true : undefined} {...register(name)}>
        <option value="">—</option>
        {node.options.map((option, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: варианты enum неизменны, а значения бывают равны по подписи (1 и "1")
          <option key={index} value={String(index)}>
            {optionLabel(option)}
          </option>
        ))}
      </select>
      <ErrorLine message={error} />
    </div>
  )
}

function JsonField({ node, name, label, required }: Props) {
  const id = useId()
  const { register } = useFormContext()
  const error = useFieldError(name)
  return (
    <div>
      <Label htmlFor={id} label={`${label} (JSON)`} required={required} description={node.description} />
      <textarea id={id} rows={4} className={`${inputClass} font-mono`} aria-invalid={error ? true : undefined} {...register(name)} />
      <ErrorLine message={error} />
    </div>
  )
}
