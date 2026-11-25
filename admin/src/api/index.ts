/**
 * Единственный клиент API админки. API — под `/api` того же origin (прокси Vite в разработке, обратный прокси
 * в проде): cookie сессии `SameSite=Strict` и JSON-only запросы защищают от CSRF только на своём origin.
 */
import { createApiClient } from './client'
import { endpoints } from './endpoints'

let onUnauthenticated: () => void = () => {}

/** Роутер подключает переход на вход после создания: клиент создаётся раньше роутера */
export function setUnauthenticatedHandler(handler: () => void): void {
  onUnauthenticated = handler
}

export const api = endpoints(createApiClient({ baseUrl: '/api', onUnauthenticated: () => onUnauthenticated() }))
