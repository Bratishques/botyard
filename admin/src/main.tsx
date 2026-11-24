import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { isApiError } from './api/client'
import { setUnauthenticatedHandler } from './api/index'
import { safeRedirect } from './redirect'
import { buildRouter } from './router'
import './index.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Ошибки 4xx не лечатся повтором; 5xx и сеть — пара повторов, как у TanStack по умолчанию
      retry: (count, error) => !(isApiError(error) && error.status >= 400 && error.status < 500) && count < 2,
      refetchOnWindowFocus: true,
    },
    // Изменения не повторяются сами: повтор решает оператор, и он уходит с тем же ключом попытки.
    // gcTime 0: переменные мутации — тело запроса, в нём бывают токен и ключ Dokploy; они не должны жить в кеше
    // после закрытия формы
    mutations: { retry: false, gcTime: 0 },
  },
})

const router = buildRouter(queryClient)

// Сессия истекла посреди работы: данные прежнего оператора убрать из кеша и отправить на вход с возвратом
setUnauthenticatedHandler(() => {
  const { pathname, href } = router.state.location
  if (pathname === '/login') return
  queryClient.clear()
  void router.navigate({ to: '/login', search: { redirect: safeRedirect(href) } })
})

const root = document.getElementById('root')
if (!root) throw new Error('#root not found')

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
)
