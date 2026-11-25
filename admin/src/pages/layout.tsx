import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, Outlet, useNavigate } from '@tanstack/react-router'
import { useEffect } from 'react'
import { isApiError } from '../api/client'
import { errorMessage } from '../api/errors'
import { api } from '../api/index'
import { connectDeploymentEvents } from '../api/live'
import { meQuery } from '../api/queries'

const nav = [
  { to: '/deployments', label: 'Развёртывания' },
  { to: '/customers', label: 'Клиенты' },
  { to: '/destinations', label: 'Назначения' },
  { to: '/templates', label: 'Каталог' },
] as const

export function Layout() {
  const me = useQuery(meQuery)
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  // Один поток событий на вкладку, пока оператор внутри админки; выход размонтирует макет и закроет поток
  useEffect(
    () =>
      connectDeploymentEvents(queryClient, {
        // 401 здесь сам уводит на вход (общий обработчик клиента) — тогда и повторять незачем
        sessionAlive: () =>
          api.auth.check().then(
            () => true,
            (error: unknown) => !(isApiError(error) && error.status === 401),
          ),
      }),
    [queryClient],
  )
  const logout = useMutation({
    mutationFn: api.auth.logout,
    // Выход отзывает сессию на сервере. Только подтверждённый: при обрыве или 5xx сессия могла остаться живой, и
    // уйти на вход значило бы оставить её следующему человеку за этим компьютером
    onSuccess: () => {
      queryClient.clear()
      void navigate({ to: '/login' })
    },
  })

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center gap-6 px-4 py-3">
          <span className="font-semibold">Botyard</span>
          <nav className="flex gap-4 text-sm">
            {nav.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                className="text-slate-600 hover:text-slate-900"
                activeProps={{ className: 'font-semibold text-slate-900' }}
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3 text-sm">
            <span className="text-slate-500">{me.data?.email}</span>
            {logout.error && <span className="text-xs text-red-700">Выход не подтверждён — повторите. {errorMessage(logout.error)}</span>}
            <button type="button" className="text-sky-700 hover:underline" onClick={() => logout.mutate()} disabled={logout.isPending}>
              Выйти
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">
        <Outlet />
      </main>
    </div>
  )
}
