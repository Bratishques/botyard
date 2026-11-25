/**
 * Маршруты админки (code-based: экранов немного, генератор маршрутов не нужен).
 * Всё, кроме входа, — под макетом `app`, который до загрузки проверяет сессию через `GET /auth/me`.
 */
import type { QueryClient } from '@tanstack/react-query'
import { createRootRouteWithContext, createRoute, createRouter, Outlet, redirect } from '@tanstack/react-router'
import { isApiError } from './api/client'
import { meQuery } from './api/queries'
import { CustomersPage } from './pages/customers'
import { DeploymentPage } from './pages/deployment'
import { DeploymentNewPage } from './pages/deployment-new'
import { DeploymentsPage } from './pages/deployments'
import { DestinationsPage } from './pages/destinations'
import { Layout } from './pages/layout'
import { LoginPage } from './pages/login'
import { TemplatePage, TemplatesPage } from './pages/templates'
import { safeRedirect } from './redirect'

export interface RouterContext {
  queryClient: QueryClient
}

const rootRoute = createRootRouteWithContext<RouterContext>()({ component: Outlet })

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  validateSearch: (search: Record<string, unknown>): { redirect?: string } => ({ redirect: safeRedirect(search.redirect) }),
  component: function LoginRoute() {
    const { redirect: to } = loginRoute.useSearch()
    return <LoginPage redirectTo={to} />
  },
})

const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'app',
  beforeLoad: async ({ context, location }) => {
    try {
      await context.queryClient.ensureQueryData(meQuery)
    } catch (error) {
      // По статусу, а не по коду: 401 с не-JSON телом (прокси) тоже значит «нет сессии»
      if (isApiError(error) && error.status === 401) throw redirect({ to: '/login', search: { redirect: location.href } })
      throw error
    }
  },
  component: Layout,
})

const indexRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: '/deployments' })
  },
})

const destinationsRoute = createRoute({ getParentRoute: () => appRoute, path: '/destinations', component: DestinationsPage })
const customersRoute = createRoute({ getParentRoute: () => appRoute, path: '/customers', component: CustomersPage })
const templatesRoute = createRoute({ getParentRoute: () => appRoute, path: '/templates', component: TemplatesPage })
const templateRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/templates/$templateId',
  component: function TemplateRoute() {
    const { templateId } = templateRoute.useParams()
    return <TemplatePage id={templateId} />
  },
})
const deploymentsRoute = createRoute({ getParentRoute: () => appRoute, path: '/deployments', component: DeploymentsPage })
const deploymentNewRoute = createRoute({ getParentRoute: () => appRoute, path: '/deployments/new', component: DeploymentNewPage })
const deploymentRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/deployments/$deploymentId',
  component: function DeploymentRoute() {
    const { deploymentId } = deploymentRoute.useParams()
    // key: при переходе между развёртываниями открытые диалоги и их попытки не переезжают на другое
    return <DeploymentPage key={deploymentId} id={deploymentId} />
  },
})

const routeTree = rootRoute.addChildren([
  loginRoute,
  appRoute.addChildren([
    indexRoute,
    destinationsRoute,
    customersRoute,
    templatesRoute,
    templateRoute,
    deploymentsRoute,
    deploymentNewRoute,
    deploymentRoute,
  ]),
])

export function buildRouter(queryClient: QueryClient) {
  return createRouter({ routeTree, context: { queryClient }, defaultPreload: false })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof buildRouter>
  }
}
