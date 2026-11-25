/**
 * Новое развёртывание: клиент → назначение → робот → конфиг по JSON Schema шаблона.
 *
 * Попытка (ключ идемпотентности) рождается при открытии страницы и живёт до подтверждённого успеха: повтор после
 * обрыва вернёт уже созданное развёртывание, а не создаст второе. Форма конфига пересоздаётся при смене шаблона
 * (свой `useForm` со схемой этого шаблона), ключ попытки при этом сохраняется — см. `api/idempotency.ts`.
 */
import { type DeploymentCreateBody, deploymentCreateSchema, type TemplateView } from '@botyard/contract'
import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { FormProvider, useForm } from 'react-hook-form'
import type { z } from 'zod'
import { type Attempt, useAttempt } from '../api/idempotency'
import { api } from '../api/index'
import { customersQuery, destinationsQuery, queryKeys, templatesQuery } from '../api/queries'
import { SchemaFields } from '../schema-form/SchemaField'
import { formSchema, parseSchema, toConfig, toFormValue } from '../schema-form/schema'
import { Button, ErrorBox, Field, inputClass, Loading, PageHeader } from '../ui/kit'

export function DeploymentNewPage() {
  // Создание без `version`: попытка переживает перезагрузку, чтобы повтор после обрыва не создал второго робота
  const attempt = useAttempt('deployment-create')
  const templates = useQuery(templatesQuery)
  const [templateId, setTemplateId] = useState('')
  const template = templates.data?.find((t) => t.id === templateId)

  return (
    <div className="max-w-2xl">
      <PageHeader title="Новое развёртывание" />
      <ErrorBox error={templates.error} />
      {templates.isPending ? (
        <Loading />
      ) : (
        <div className="space-y-4 rounded border border-slate-200 bg-white p-4">
          <Field label="Робот">
            {(id) => (
              <select id={id} className={inputClass} value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
                <option value="">— выберите шаблон —</option>
                {templates.data
                  ?.filter((t) => !t.retired)
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} ({t.id})
                    </option>
                  ))}
              </select>
            )}
          </Field>
          {template && <DeploymentForm key={template.id} template={template} attempt={attempt} />}
        </div>
      )}
    </div>
  )
}

function DeploymentForm({ template, attempt }: { template: TemplateView; attempt: Attempt }) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const customers = useQuery(customersQuery)
  const destinations = useQuery(destinationsQuery)

  const node = useMemo(() => parseSchema(template.configSchema), [template.configSchema])
  // Выбор клиента и назначения — правила контракта, конфиг — подсказка по схеме шаблона (полную проверку делает сервер)
  const schema = useMemo(
    () => deploymentCreateSchema.pick({ customerId: true, destinationId: true }).extend({ config: formSchema(node) }),
    [node],
  )
  const form = useForm<z.input<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: { customerId: '', destinationId: '', config: toFormValue(node) },
  })

  const create = useMutation({
    mutationFn: (body: DeploymentCreateBody) => attempt.run((key) => api.deployments.create(body, key)),
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.deployments })
      void navigate({ to: '/deployments/$deploymentId', params: { deploymentId: created.id } })
    },
  })

  const submit = form.handleSubmit((values) => {
    const body = deploymentCreateSchema.safeParse({
      customerId: values.customerId,
      destinationId: values.destinationId,
      templateId: template.id,
      config: toConfig(node, values.config),
    })
    // Сюда попадает только конфиг-не-объект: корень схемы, который форма не разобрала, и JSON-массив в нём
    if (!body.success) form.setError('root', { message: 'Конфиг должен быть JSON-объектом' })
    else create.mutate(body.data)
  })

  const errors = form.formState.errors
  // Архивного клиента и выключенное назначение API не примет: в выбор они не попадают
  const activeCustomers = customers.data?.filter((c) => c.status === 'ACTIVE') ?? []
  const usableDestinations = destinations.data?.filter((d) => d.status !== 'DISABLED') ?? []

  return (
    <FormProvider {...form}>
      <form className="space-y-4" onSubmit={submit} noValidate>
        <ErrorBox error={customers.error ?? destinations.error} />
        <Field label="Клиент" error={errors.customerId && 'Выберите клиента'}>
          {(id) => (
            <select id={id} className={inputClass} {...form.register('customerId')}>
              <option value="">—</option>
              {activeCustomers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} · {c.mode === 'live' ? 'БОЕВОЙ' : 'песочница'}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Назначение" error={errors.destinationId && 'Выберите назначение'}>
          {(id) => (
            <select id={id} className={inputClass} {...form.register('destinationId')}>
              <option value="">—</option>
              {usableDestinations.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} ({d.status})
                </option>
              ))}
            </select>
          )}
        </Field>
        <fieldset className="space-y-3 rounded border border-slate-200 p-3">
          <legend className="px-1 text-sm font-semibold">Конфиг {template.name}</legend>
          <SchemaFields node={node} name="config" />
        </fieldset>
        {errors.root?.message && (
          <p role="alert" className="text-sm text-red-600">
            {errors.root.message}
          </p>
        )}
        <ErrorBox error={create.error} />
        <div className="flex justify-end">
          <Button type="submit" variant="primary" disabled={create.isPending}>
            {create.isPending ? 'Отправляем…' : 'Развернуть'}
          </Button>
        </div>
      </form>
    </FormProvider>
  )
}
