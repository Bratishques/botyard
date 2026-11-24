/**
 * Живой статус развёртывания — шов для SSE этапа 3.
 *
 * Сейчас статус приходит опросом: пока у развёртывания идёт операция, его запрос перечитывается каждые
 * `POLL_MS`. Когда api получит SSE, сюда добавится подписка на события, которая инвалидирует те же запросы
 * (`queryKeys.deployment(id)`, `queryKeys.deployments`), а `refetchInterval` станет запасным путём на время обрыва
 * потока. Экраны берут интервал только отсюда и не знают, откуда приходит обновление.
 *
 * Оптимистичных переходов нет: интерфейс показывает статус, который вернул сервер.
 */
import type { DeploymentView } from '@botyard/contract'

export const POLL_MS = 3000

/**
 * Идёт ли у развёртывания работа, за которой стоит следить. Признак — активная операция, а не статус: упавшее
 * удаление оставляет `DELETING` без операции, и опрашивать его бесконечно незачем
 */
export function isBusy(deployment: Pick<DeploymentView, 'activeOperationId'>): boolean {
  return deployment.activeOperationId !== null
}

/** Интервал перечитывания для одного развёртывания: опрос только пока идёт операция */
export function deploymentRefetchInterval(deployment: DeploymentView | undefined): number | false {
  return deployment && isBusy(deployment) ? POLL_MS : false
}

/** Для списка: опрос, пока хоть одно развёртывание занято */
export function deploymentsRefetchInterval(deployments: DeploymentView[] | undefined): number | false {
  return deployments?.some(isBusy) ? POLL_MS : false
}
