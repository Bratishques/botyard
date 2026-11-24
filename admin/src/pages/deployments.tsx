/** Список развёртываний. Пока у кого-то идёт операция, список перечитывается (см. `api/live.ts`) */
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { isBusy } from '../api/live'
import { customersQuery, deploymentsQuery, destinationsQuery } from '../api/queries'
import { Badge, ErrorBox, formatTime, Loading, PageHeader, Table, Td } from '../ui/kit'

/** Имена клиентов и назначений вместо uuid: отдельные списки, справочно — их ошибка не ломает экран */
export function useNames() {
  const customers = useQuery(customersQuery)
  const destinations = useQuery(destinationsQuery)
  return {
    customer: (id: string) => customers.data?.find((c) => c.id === id)?.name ?? id,
    destination: (id: string) => destinations.data?.find((d) => d.id === id)?.name ?? id,
  }
}

export function DeploymentsPage() {
  const list = useQuery(deploymentsQuery)
  const names = useNames()
  return (
    <div>
      <PageHeader title="Развёртывания">
        <Link to="/deployments/new" className="rounded bg-sky-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-800">
          Развернуть
        </Link>
      </PageHeader>
      <ErrorBox error={list.error} />
      {list.isPending ? (
        <Loading />
      ) : (
        <Table head={['Приложение', 'Клиент', 'Робот', 'Назначение', 'Режим', 'Статус', 'Изменено']}>
          {list.data?.map((d) => (
            <tr key={d.id}>
              <Td>
                <Link to="/deployments/$deploymentId" params={{ deploymentId: d.id }} className="font-mono text-sky-700 hover:underline">
                  {d.appName}
                </Link>
              </Td>
              <Td>{names.customer(d.customerId)}</Td>
              <Td className="font-mono text-xs">{d.templateId}</Td>
              <Td>{names.destination(d.destinationId)}</Td>
              <Td>
                <Badge value={d.tradingMode} />
              </Td>
              <Td>
                <Badge value={d.status} />
                {isBusy(d) && <span className="ml-1 text-xs text-sky-700">идёт операция…</span>}
              </Td>
              <Td className="text-xs">{formatTime(d.updatedAt)}</Td>
            </tr>
          ))}
        </Table>
      )}
      {list.data?.length === 0 && <p className="mt-3 text-sm text-slate-500">Развёртываний пока нет.</p>}
    </div>
  )
}
