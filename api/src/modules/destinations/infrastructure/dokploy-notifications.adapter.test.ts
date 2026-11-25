import { describe, expect, test } from 'bun:test'
import { DEFAULT_DOKPLOY_CLIENT, DokployClient } from '../../../shared/dokploy/dokploy.client'
import { DokployNotificationsAdapter } from './dokploy-notifications.adapter'

/** Dokploy в памяти: список уведомлений и записанные вызовы */
function dokploy(notifications: { notificationId: string; name: string; notificationType: string; customId: string }[]) {
  const calls: { method: string; body: unknown }[] = []
  const fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const method = new URL(String(input)).pathname.replace('/api/', '')
      calls.push({ method, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      if (method === 'notification.all') return Response.json(notifications)
      return new Response(null, { status: 200 })
    },
    { preconnect: () => undefined },
  )
  return { client: new DokployClient({ ...DEFAULT_DOKPLOY_CLIENT, fetch }), calls }
}

describe('уведомление Dokploy', () => {
  test('два уведомления с одним именем (гонка регистраций) — лишнее удаляется, первое перезаписывается', async () => {
    const name = 'botyard-dest'
    const { client, calls } = dokploy([
      { notificationId: 'n1', name, notificationType: 'custom', customId: 'c1' },
      { notificationId: 'n2', name, notificationType: 'custom', customId: 'c2' },
      { notificationId: 'other', name: 'someone-else', notificationType: 'custom', customId: 'c3' },
    ])

    const id = await new DokployNotificationsAdapter(client).upsertCustom('https://d.example.com', 'k', {
      name,
      endpoint: 'https://botyard.example.com/webhooks/dokploy/x',
      headers: { 'x-botyard-token': 's' },
    })

    expect(id).toBe('n1')
    expect(calls.filter((call) => call.method === 'notification.remove').map((call) => call.body)).toEqual([{ notificationId: 'n2' }])
    expect(calls.find((call) => call.method === 'notification.updateCustom')?.body).toMatchObject({ notificationId: 'n1', customId: 'c1' })
    expect(calls.some((call) => call.method === 'notification.createCustom')).toBe(false)
  })

  test('какое из дублей оставить — не зависит от порядка ответа Dokploy: две чистки оставят одно и то же', async () => {
    const name = 'botyard-dest'
    const n1 = { notificationId: 'n1', name, notificationType: 'custom', customId: 'c1' }
    const n2 = { notificationId: 'n2', name, notificationType: 'custom', customId: 'c2' }
    const kept = async (list: (typeof n1)[]) => {
      const { client, calls } = dokploy(list)
      const id = await new DokployNotificationsAdapter(client).upsertCustom('https://d.example.com', 'k', {
        name,
        endpoint: 'https://botyard.example.com/webhooks/dokploy/x',
        headers: {},
      })
      return { id, removed: calls.filter((call) => call.method === 'notification.remove').map((call) => call.body) }
    }

    expect(await kept([n2, n1])).toEqual({ id: 'n1', removed: [{ notificationId: 'n2' }] })
    expect(await kept([n1, n2])).toEqual({ id: 'n1', removed: [{ notificationId: 'n2' }] })
  })
})
