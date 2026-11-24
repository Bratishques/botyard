import { type LoginBody, loginSchema } from '@botyard/contract'
import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useForm } from 'react-hook-form'
import { api } from '../api/index'
import { queryKeys } from '../api/queries'
import { Button, ErrorBox, Field, inputClass } from '../ui/kit'

export function LoginPage({ redirectTo }: { redirectTo?: string }) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const form = useForm<LoginBody>({ resolver: zodResolver(loginSchema), defaultValues: { email: '', password: '' } })
  const login = useMutation({
    mutationFn: api.auth.login,
    onSuccess: (operator) => {
      // Новый оператор не должен увидеть кеш прежнего
      queryClient.clear()
      queryClient.setQueryData(queryKeys.me, operator)
      // href, а не to: в сохранённом адресе бывают search и hash
      if (redirectTo) void navigate({ href: redirectTo })
      else void navigate({ to: '/deployments' })
    },
  })

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <form
        className="w-full max-w-sm space-y-4 rounded-lg border border-slate-200 bg-white p-6 shadow-sm"
        onSubmit={form.handleSubmit((body) => login.mutate(body))}
        noValidate
      >
        <h1 className="text-xl font-semibold">Вход в Botyard</h1>
        <Field label="Почта" error={form.formState.errors.email && 'Введите почту'}>
          {(id) => <input id={id} type="email" autoComplete="username" className={inputClass} {...form.register('email')} />}
        </Field>
        <Field label="Пароль" error={form.formState.errors.password && 'Введите пароль'}>
          {(id) => <input id={id} type="password" autoComplete="current-password" className={inputClass} {...form.register('password')} />}
        </Field>
        <ErrorBox error={login.error} />
        <Button type="submit" variant="primary" className="w-full" disabled={login.isPending}>
          {login.isPending ? 'Входим…' : 'Войти'}
        </Button>
      </form>
    </div>
  )
}
