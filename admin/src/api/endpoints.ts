/**
 * Ручки админ-API. Тела — типы из `@botyard/contract` (их же проверяет сервер), ответы — view-типы оттуда же.
 * Только развёртывания получают `Idempotency-Key`: назначения и клиентов от дублей защищают уникальность
 * имени и правка по `version`.
 */
import type {
  CustomerCreateBody,
  CustomerLiveBody,
  CustomerSandboxBody,
  CustomerTokenBody,
  CustomerUpdateBody,
  CustomerView,
  DeploymentAcceptedView,
  DeploymentAction,
  DeploymentCreateBody,
  DeploymentDetailsView,
  DeploymentLogsView,
  DeploymentView,
  DestinationPreviewBody,
  DestinationPreviewView,
  DestinationUpdateBody,
  DestinationView,
  destinationCreateSchema,
  LoginBody,
  OperatorView,
  TemplateView,
  VersionBody,
} from '@botyard/contract'
import type { z } from 'zod'
import type { ApiClient } from './client'

/** Тело создания назначения на входе схемы: `serverId` с default, его можно не передавать */
type DestinationCreateInput = z.input<typeof destinationCreateSchema>

const id = encodeURIComponent

export function endpoints(api: ApiClient) {
  return {
    auth: {
      // 401 здесь — штатный ответ «не вошёл»: его разбирает проверка маршрута, а не общий переход на вход
      me: () => api.get<OperatorView>('/auth/me', { skipAuthRedirect: true }),
      // Жива ли сессия — с общим переходом на вход при 401 (поток SSE статуса ответа не видит)
      check: () => api.get<OperatorView>('/auth/me'),
      login: (body: LoginBody) => api.post<OperatorView>('/auth/login', body, { skipAuthRedirect: true }),
      logout: () => api.post<void>('/auth/logout', {}, { skipAuthRedirect: true }),
    },
    destinations: {
      list: () => api.get<DestinationView[]>('/destinations'),
      get: (destinationId: string) => api.get<DestinationView>(`/destinations/${id(destinationId)}`),
      preview: (body: DestinationPreviewBody) => api.post<DestinationPreviewView>('/destinations/preview', body),
      create: (body: DestinationCreateInput) => api.post<DestinationView>('/destinations', body),
      update: (destinationId: string, body: DestinationUpdateBody) =>
        api.patch<DestinationView>(`/destinations/${id(destinationId)}`, body),
      check: (destinationId: string) => api.post<DestinationView>(`/destinations/${id(destinationId)}/check`, {}),
      disable: (destinationId: string, body: VersionBody) => api.post<DestinationView>(`/destinations/${id(destinationId)}/disable`, body),
      enable: (destinationId: string, body: VersionBody) => api.post<DestinationView>(`/destinations/${id(destinationId)}/enable`, body),
    },
    templates: {
      list: () => api.get<TemplateView[]>('/templates'),
      get: (templateId: string) => api.get<TemplateView>(`/templates/${id(templateId)}`),
    },
    customers: {
      list: () => api.get<CustomerView[]>('/customers'),
      get: (customerId: string) => api.get<CustomerView>(`/customers/${id(customerId)}`),
      create: (body: CustomerCreateBody) => api.post<CustomerView>('/customers', body),
      update: (customerId: string, body: CustomerUpdateBody) => api.patch<CustomerView>(`/customers/${id(customerId)}`, body),
      rotateToken: (customerId: string, body: CustomerTokenBody) => api.post<CustomerView>(`/customers/${id(customerId)}/token`, body),
      goLive: (customerId: string, body: CustomerLiveBody) => api.post<CustomerView>(`/customers/${id(customerId)}/live`, body),
      toSandbox: (customerId: string, body: CustomerSandboxBody) => api.post<CustomerView>(`/customers/${id(customerId)}/sandbox`, body),
      archive: (customerId: string, body: VersionBody) => api.post<CustomerView>(`/customers/${id(customerId)}/archive`, body),
    },
    deployments: {
      logs: (deploymentId: string, tail: number) => api.get<DeploymentLogsView>(`/deployments/${id(deploymentId)}/logs?tail=${tail}`),
      list: () => api.get<DeploymentView[]>('/deployments'),
      get: (deploymentId: string) => api.get<DeploymentDetailsView>(`/deployments/${id(deploymentId)}`),
      create: (body: DeploymentCreateBody, idempotencyKey: string) =>
        api.post<DeploymentAcceptedView>('/deployments', body, { idempotencyKey }),
      act: (deploymentId: string, action: DeploymentAction, body: VersionBody, idempotencyKey: string) =>
        api.post<DeploymentAcceptedView>(`/deployments/${id(deploymentId)}/${action}`, body, { idempotencyKey }),
    },
  }
}

export type Endpoints = ReturnType<typeof endpoints>
