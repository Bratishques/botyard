import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { sql } from 'kysely'
import { createHttpApp } from '../../src/main'
import { hashToken } from '../../src/modules/auth/application/auth.service'
import { CreateOperator } from '../../src/modules/auth/application/create-operator'
import { PostgresOperatorRepository } from '../../src/modules/auth/infrastructure/postgres-auth.repositories'
import { AuditLog } from '../../src/shared/audit/audit'
import { loadConfig } from '../../src/shared/config/config'
import { UnitOfWork } from '../../src/shared/database/unit-of-work'
import projectsFixture from '../fixtures/dokploy/project.all.json'
import unauthorizedFixture from '../fixtures/dokploy/unauthorized.json'
import { db } from './setup'

/**
 * Сквозной HTTP: настоящее приложение и настоящий клиент Dokploy, а Dokploy — заглушка на Bun.serve,
 * отвечающая записанными фикстурами. Ключ заглушка принимает один.
 */
const DOKPLOY_KEY = 'dokploy-key-for-api-test-0123456789'
const PASSWORD = 'correct horse battery staple'
const environmentId = projectsFixture[0]?.environments[0]?.environmentId ?? ''

let app: NestExpressApplication
let base: string
let dokploy: ReturnType<typeof Bun.serve>
let email: string
let operatorId: string

beforeAll(async () => {
  dokploy = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request) {
      if (request.headers.get('x-api-key') !== DOKPLOY_KEY) return Response.json(unauthorizedFixture, { status: 401 })
      const method = new URL(request.url).pathname.replace('/api/', '')
      if (method === 'project.all') return Response.json(projectsFixture)
      if (method === 'server.all') return Response.json([])
      return Response.json({ message: 'not found' }, { status: 404 })
    },
  })

  const metricsProbe = Bun.serve({ port: 0, fetch: () => new Response() })
  const metricsPort = metricsProbe.port ?? 0
  metricsProbe.stop(true)

  app = await createHttpApp(
    loadConfig({
      ...process.env,
      PORT: '1',
      METRICS_PORT: String(metricsPort),
      METRICS_HOST: '127.0.0.1',
      DESTINATIONS_ALLOW_HTTP: 'true',
      SESSION_COOKIE_SECURE: 'false',
    }),
  )
  await app.listen(0, '127.0.0.1')
  const address = app.getHttpServer().address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`

  email = `operator-${crypto.randomUUID().slice(0, 8)}@botyard.local`
  const unitOfWork = app.get(UnitOfWork)
  const createOperator = new CreateOperator(new PostgresOperatorRepository(unitOfWork), unitOfWork, app.get(AuditLog))
  operatorId = (await createOperator.execute(email, PASSWORD, 'system:test')).id
})

afterAll(async () => {
  await app.close()
  dokploy.stop(true)
})

const json = (body: unknown, cookie?: string): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(cookie && { cookie }) },
  body: JSON.stringify(body),
})

async function login(password = PASSWORD, as = email): Promise<Response> {
  return fetch(`${base}/auth/login`, json({ email: as, password }))
}

async function session(): Promise<string> {
  const response = await login()
  const cookie = response.headers.get('set-cookie') ?? ''

  return cookie.split(';')[0] ?? ''
}

describe('вход', () => {
  test('успешный вход ставит httpOnly cookie со SameSite=Strict', async () => {
    const response = await login()
    const cookie = response.headers.get('set-cookie') ?? ''

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ email })
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Strict')
  })

  test('неверный пароль и неизвестная почта — одинаковый ответ', async () => {
    const wrong = await login('wrong password')
    const unknown = await login(PASSWORD, 'nobody@botyard.local')

    expect(wrong.status).toBe(401)
    expect(unknown.status).toBe(401)
    expect(await wrong.json()).toEqual(await unknown.json())
  })

  test('без сессии закрыто всё, кроме health и входа', async () => {
    const response = await fetch(`${base}/destinations`)

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ code: 'UNAUTHENTICATED', message: 'sign in required' })
    expect((await fetch(`${base}/health/live`)).status).toBe(200)
  })

  test('изменяющий запрос не JSON — 415 (защита от CSRF через форму)', async () => {
    const cookie = await session()
    const response = await fetch(`${base}/destinations`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: 'name=x',
    })

    expect(response.status).toBe(415)
  })

  test('выход с мёртвой cookie — 204 и cookie очищена; повторный выход пишет аудит один раз', async () => {
    const cookie = await session()
    expect((await fetch(`${base}/auth/logout`, json({}, cookie))).status).toBe(204)
    const again = await fetch(`${base}/auth/logout`, json({}, cookie))

    expect(again.status).toBe(204)
    expect(again.headers.get('set-cookie') ?? '').toContain('botyard_session=;')
    const token = decodeURIComponent(cookie.split('=').slice(1).join('='))
    const session_ = await db
      .selectFrom('operator_session')
      .select('revoked_at')
      .where('token_hash', '=', hashToken(token))
      .executeTakeFirstOrThrow()
    expect(session_.revoked_at).not.toBeNull()
    const logouts = await db
      .selectFrom('audit_event')
      .select('id')
      .where('action', '=', 'operator.logged_out')
      .where('target_id', '=', operatorId)
      .execute()
    expect(logouts.length).toBe(new Set(logouts.map((row) => row.id)).size)
  })

  test('истёкшая сессия не пускает', async () => {
    const cookie = await session()
    const token = decodeURIComponent(cookie.split('=').slice(1).join('='))
    // Подделка времени — сырым SQL: тип схемы правильно запрещает менять created_at из кода
    await sql`UPDATE operator_session SET created_at = now() - interval '2 seconds', expires_at = now() - interval '1 second'
      WHERE token_hash = ${hashToken(token)}`.execute(db)

    expect((await fetch(`${base}/auth/me`, { headers: { cookie } })).status).toBe(401)
  })

  test('битая cookie — 401, а не 500', async () => {
    expect((await fetch(`${base}/auth/me`, { headers: { cookie: 'botyard_session=%E0%A4%A' } })).status).toBe(401)
  })

  test('почта при входе нормализуется; Content-Type в другом регистре принимается', async () => {
    const response = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'Application/JSON' },
      body: JSON.stringify({ email: `  ${email.toUpperCase()}  `, password: PASSWORD }),
    })

    expect(response.status).toBe(200)
  })

  test('битый JSON — 400 INVALID_JSON без эха тела', async () => {
    const response = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"password": SECRETVALUE',
    })
    const text = await response.text()

    expect(response.status).toBe(400)
    expect(JSON.parse(text)).toEqual({ code: 'INVALID_JSON', message: 'request body is not valid JSON' })
    expect(text).not.toContain('SECRETVALUE')
  })

  test('неудача по неизвестной почте в аудит не попадает', async () => {
    const ghost = `ghost-${crypto.randomUUID().slice(0, 8)}@botyard.local`
    await login(PASSWORD, ghost)

    const rows = await sql<{ n: number }>`SELECT count(*)::int AS n FROM audit_event WHERE payload::text LIKE ${`%${ghost}%`}`.execute(db)
    expect(rows.rows[0]?.n).toBe(0)
  })

  test('перебор пароля упирается в лимит: 429 с Retry-After, правильный пароль тоже ждёт', async () => {
    const victim = `victim-${crypto.randomUUID().slice(0, 8)}@botyard.local`
    const unitOfWork = app.get(UnitOfWork)
    await new CreateOperator(new PostgresOperatorRepository(unitOfWork), unitOfWork, app.get(AuditLog)).execute(
      victim,
      PASSWORD,
      'system:test',
    )

    for (let i = 0; i < 5; i++) expect((await login('wrong password', victim)).status).toBe(401)
    const blocked = await login(PASSWORD, victim)

    expect(blocked.status).toBe(429)
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(((await blocked.json()) as { code: string }).code).toBe('LOGIN_THROTTLED')
  })

  test('тот же оператор дважды — OPERATOR_EXISTS', async () => {
    const unitOfWork = app.get(UnitOfWork)
    const create = new CreateOperator(new PostgresOperatorRepository(unitOfWork), unitOfWork, app.get(AuditLog))

    await expect(create.execute(email, PASSWORD, 'system:test')).rejects.toMatchObject({ code: 'OPERATOR_EXISTS' })
  })

  test('выход отзывает сессию сразу', async () => {
    const cookie = await session()
    expect((await fetch(`${base}/auth/me`, { headers: { cookie } })).status).toBe(200)

    expect((await fetch(`${base}/auth/logout`, json({}, cookie))).status).toBe(204)
    expect((await fetch(`${base}/auth/me`, { headers: { cookie } })).status).toBe(401)
  })
})

describe('назначения по HTTP', () => {
  test('создание, чтение и правка: ключ не возвращается, старая версия — 409', async () => {
    const cookie = await session()
    const dokployUrl = `http://127.0.0.1:${dokploy.port}/`

    const preview = await fetch(`${base}/destinations/preview`, json({ baseUrl: dokployUrl, apiKey: DOKPLOY_KEY }, cookie))
    expect(preview.status).toBe(200)
    expect(((await preview.json()) as { environments: unknown[] }).environments.length).toBe(2)

    const created = await fetch(
      `${base}/destinations`,
      json({ name: `http-${crypto.randomUUID().slice(0, 6)}`, baseUrl: dokployUrl, apiKey: DOKPLOY_KEY, environmentId }, cookie),
    )
    const createdText = await created.text()
    expect(created.status).toBe(201)
    expect(createdText).not.toContain(DOKPLOY_KEY)
    expect(createdText).not.toContain('apiKeySealed')
    const destination = JSON.parse(createdText) as { id: string; version: number; apiKeyHint: string; baseUrl: string }
    expect(destination.baseUrl).toBe(`http://127.0.0.1:${dokploy.port}`)
    expect(destination.apiKeyHint).toBe('••••6789')

    const renamed = await fetch(`${base}/destinations/${destination.id}`, {
      ...json({ version: 1, name: `renamed-${destination.id.slice(-6)}` }, cookie),
      method: 'PATCH',
    })
    expect(renamed.status).toBe(200)

    const stale = await fetch(`${base}/destinations/${destination.id}`, { ...json({ version: 1, name: 'stale' }, cookie), method: 'PATCH' })
    expect(stale.status).toBe(409)
    expect(((await stale.json()) as { code: string }).code).toBe('DESTINATION_VERSION_CONFLICT')
  })

  test('неверный ключ Dokploy — 422 KEY_REJECTED; ошибка валидации не повторяет ключ', async () => {
    const cookie = await session()
    const dokployUrl = `http://127.0.0.1:${dokploy.port}`

    const rejected = await fetch(
      `${base}/destinations`,
      json({ name: 'x', baseUrl: dokployUrl, apiKey: 'wrong-key-123456', environmentId }, cookie),
    )
    expect(rejected.status).toBe(422)
    expect(((await rejected.json()) as { code: string }).code).toBe('DESTINATION_KEY_REJECTED')

    const invalid = await fetch(`${base}/destinations`, json({ name: 'x', baseUrl: dokployUrl, apiKey: 'SECRET-VALUE-123456' }, cookie))
    const text = await invalid.text()
    expect(invalid.status).toBe(400)
    expect(JSON.parse(text).code).toBe('VALIDATION_FAILED')
    expect(text).not.toContain('SECRET-VALUE')
  })
})
