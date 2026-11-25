/** Ключи и опции запросов TanStack Query: экраны и инвалидация после изменений ссылаются на одни и те же ключи */
import { queryOptions } from '@tanstack/react-query'
import { api } from './index'
import { deploymentRefetchInterval, deploymentsRefetchInterval } from './live'

export const queryKeys = {
  me: ['me'] as const,
  destinations: ['destinations'] as const,
  destination: (id: string) => ['destinations', id] as const,
  customers: ['customers'] as const,
  templates: ['templates'] as const,
  template: (id: string) => ['templates', id] as const,
  deployments: ['deployments'] as const,
  deployment: (id: string) => ['deployments', id] as const,
}

export const meQuery = queryOptions({ queryKey: queryKeys.me, queryFn: api.auth.me, staleTime: 60_000, retry: false })
export const destinationsQuery = queryOptions({ queryKey: queryKeys.destinations, queryFn: api.destinations.list })
export const customersQuery = queryOptions({ queryKey: queryKeys.customers, queryFn: api.customers.list })
export const templatesQuery = queryOptions({ queryKey: queryKeys.templates, queryFn: api.templates.list })
export const templateQuery = (id: string) => queryOptions({ queryKey: queryKeys.template(id), queryFn: () => api.templates.get(id) })
export const deploymentsQuery = queryOptions({
  queryKey: queryKeys.deployments,
  queryFn: api.deployments.list,
  refetchInterval: (query) => deploymentsRefetchInterval(query.state.data),
})
export const deploymentQuery = (id: string) =>
  queryOptions({
    queryKey: queryKeys.deployment(id),
    queryFn: () => api.deployments.get(id),
    refetchInterval: (query) => deploymentRefetchInterval(query.state.data),
  })
