import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { sql } from 'kysely'
import { createHttpApp } from '../../src/main'
import { hashToken } from '../../src/modules/auth/application/auth.service'
import { CreateOperator } from '../../src/modules/auth/application/create-operator'
import { PostgresOperatorRepository } from '../../src/modules/auth/infrastructure/postgres-auth.repositories'
import { SyncCatalog } from '../../src/modules/catalog/application/sync-catalog'
import { FilesystemCatalogSource } from '../../src/modules/catalog/infrastructure/filesystem-catalog.source'
import { PostgresCatalogRepository } from '../../src/modules/catalog/infrastructure/postgres-catalog.repository'
import { AuditLog } from '../../src/shared/audit/audit'
import { loadCatalogConfig, loadConfig } from '../../src/shared/config/config'
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
      // Как за Traefik: один прокси, клиентский адрес — последний в X-Forwarded-For
      TRUST_PROXY: '1',
    }),
  )
  await app.listen(0, '127.0.0.1')
  const address = app.getHttpServer().address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`

  email = `operator-${crypto.randomUUID().slice(0, 8)}@botyard.local`
  const unitOfWork = app.get(UnitOfWork)
  const createOperator = new CreateOperator(new PostgresOperatorRepository(unitOfWork), unitOfWork, app.get(AuditLog))
  await createOperator.execute(email, PASSWORD, 'system:test')
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

/** Каждый вход — со своего адреса, чтобы тесты не делили лимит IP; `ip` — задать адрес явно */
async function login(password = PASSWORD, as = email, ip = randomIp()): Promise<Response> {
  const request = json({ email: as, password })
  return fetch(`${base}/auth/login`, { ...request, headers: { ...request.headers, 'x-forwarded-for': ip } })
}

function randomIp(): string {
  return `10.${randomOctet()}.${randomOctet()}.${randomOctet()}`
}

function randomOctet(): number {
  return Math.floor(Math.random() * 254) + 1
}

async function freshOperator(): Promise<{ id: string; email: string }> {
  const unitOfWork = app.get(UnitOfWork)
  const create = new CreateOperator(new PostgresOperatorRepository(unitOfWork), unitOfWork, app.get(AuditLog))

  return create.execute(`op-${crypto.randomUUID().slice(0, 8)}@botyard.local`, PASSWORD, 'system:test')
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
    const operator = await freshOperator()
    const cookie = ((await login(PASSWORD, operator.email)).headers.get('set-cookie') ?? '').split(';')[0] ?? ''
    expect((await fetch(`${base}/auth/logout`, json({}, cookie))).status).toBe(204)
    const again = await fetch(`${base}/auth/logout`, json({}, cookie))

    expect(again.status).toBe(204)
    expect(again.headers.get('set-cookie') ?? '').toContain('botyard_session=;')
    const logouts = await db
      .selectFrom('audit_event')
      .select('id')
      .where('action', '=', 'operator.logged_out')
      .where('target_id', '=', operator.id)
      .execute()
    expect(logouts).toHaveLength(1)
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
    const count = async () =>
      (await sql<{ n: number }>`SELECT count(*)::int AS n FROM audit_event WHERE action = 'operator.login_failed'`.execute(db)).rows[0]?.n
    const before = await count()
    expect((await login(PASSWORD, `ghost-${crypto.randomUUID().slice(0, 8)}@botyard.local`)).status).toBe(401)

    expect(await count()).toBe(before)
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

  test('залп параллельных неверных паролей не обгоняет лимит: неудач не больше пяти, остальные — 429', async () => {
    const operator = await freshOperator()
    const responses = await Promise.all(Array.from({ length: 18 }, () => login('wrong password', operator.email)))
    const statuses = responses.map((response) => response.status)

    expect(statuses.filter((status) => status === 401).length).toBeLessThanOrEqual(5)
    expect(statuses.filter((status) => status === 429).length).toBeGreaterThan(0)
  })

  test('подделанный X-Forwarded-For не обходит лимит IP: считается последний адрес цепочки', async () => {
    const proxyIp = randomIp()
    const statuses: number[] = []
    for (let i = 0; i < 21; i++) {
      statuses.push((await login('wrong password', `nobody${i}@botyard.local`, `203.0.113.${i + 1}, ${proxyIp}`)).status)
    }

    expect(statuses.slice(0, 20).every((status) => status === 401)).toBe(true)
    expect(statuses[20]).toBe(429)
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

describe('развёртывания по HTTP', () => {
  test('изменяющий запрос без Idempotency-Key — 400, до любой записи', async () => {
    const cookie = await session()
    const response = await fetch(
      `${base}/deployments`,
      json({ customerId: crypto.randomUUID(), destinationId: crypto.randomUUID(), templateId: 'bita', config: {} }, cookie),
    )

    expect(response.status).toBe(400)
    expect(((await response.json()) as { code: string }).code).toBe('IDEMPOTENCY_KEY_REQUIRED')
  })

  const withKey = (init: RequestInit, key: string): RequestInit => ({ ...init, headers: { ...init.headers, 'idempotency-key': key } })

  async function deploymentBody(cookie: string) {
    const unitOfWork = app.get(UnitOfWork)
    const source = new FilesystemCatalogSource(loadCatalogConfig().BOTS_CATALOG_DIR)
    await new SyncCatalog(source, new PostgresCatalogRepository(unitOfWork), unitOfWork, app.get(AuditLog)).execute('system:test')
    const customer = await fetch(
      `${base}/customers`,
      json(
        { name: `http-${crypto.randomUUID().slice(0, 8)}`, accountId: 'sandbox-account', token: 't.sandbox-token-0123456789abcdef' },
        cookie,
      ),
    )
    expect(customer.status).toBe(201)
    const destinationId = Bun.randomUUIDv7()
    await db
      .insertInto('destination')
      .values({
        id: destinationId,
        name: `http-dest-${destinationId.slice(-8)}`,
        base_url: `https://dokploy-${destinationId.slice(-8)}.example.com`,
        api_key_sealed: new Uint8Array([1]),
        api_key_hint: '••••abcd',
        project_id: 'prj',
        environment_id: `env-${destinationId.slice(-12)}`,
        server_id: null,
      })
      .execute()

    return {
      customerId: ((await customer.json()) as { id: string }).id,
      destinationId,
      templateId: 'bita',
      config: { figi: ['BBG004730N88'] },
    }
  }

  test('повтор создания с тем же ключом — 201 и тот же ответ, одно развёртывание; другое тело — 409', async () => {
    const cookie = await session()
    const body = await deploymentBody(cookie)
    const key = `http-${crypto.randomUUID()}`

    const first = await fetch(`${base}/deployments`, withKey(json(body, cookie), key))
    const second = await fetch(`${base}/deployments`, withKey(json(body, cookie), key))
    expect([first.status, second.status]).toEqual([201, 201])
    const created = (await first.json()) as { id: string; tradingMode: string }
    expect(await second.json()).toEqual(created)
    expect(created.tradingMode).toBe('sandbox')
    const rows = await db.selectFrom('bot_deployment').select('id').where('customer_id', '=', body.customerId).execute()
    expect(rows).toHaveLength(1)

    const other = await fetch(`${base}/deployments`, withKey(json({ ...body, config: { figi: ['OTHER'] } }, cookie), key))
    expect(other.status).toBe(409)
    expect(((await other.json()) as { code: string }).code).toBe('IDEMPOTENCY_CONFLICT')
  })

  test('операция — 202, повтор — 202 и та же операция; тот же ключ для другой операции — 409; неизвестное действие — 404', async () => {
    const cookie = await session()
    const created = (await (
      await fetch(`${base}/deployments`, withKey(json(await deploymentBody(cookie), cookie), `c-${crypto.randomUUID()}`))
    ).json()) as {
      id: string
    }
    // Воркера ещё нет (этап 2, шаг 3): завершение provision — прямой записью
    await db.updateTable('bot_deployment').set({ status: 'RUNNING', active_operation_id: null }).where('id', '=', created.id).execute()
    const version = (await db.selectFrom('bot_deployment').select('version').where('id', '=', created.id).executeTakeFirstOrThrow()).version
    const key = `op-${crypto.randomUUID()}`

    const stop = await fetch(`${base}/deployments/${created.id}/stop`, withKey(json({ version }, cookie), key))
    const again = await fetch(`${base}/deployments/${created.id}/stop`, withKey(json({ version }, cookie), key))
    expect([stop.status, again.status]).toEqual([202, 202])
    const first = (await stop.json()) as { operation: { id: string; kind: string } }
    expect(first.operation.kind).toBe('STOP')
    expect(((await again.json()) as { operation: { id: string } }).operation.id).toBe(first.operation.id)

    const start = await fetch(`${base}/deployments/${created.id}/start`, withKey(json({ version }, cookie), key))
    expect(start.status).toBe(409)
    expect(((await start.json()) as { code: string }).code).toBe('IDEMPOTENCY_CONFLICT')

    const unknown = await fetch(`${base}/deployments/${created.id}/explode`, withKey(json({ version }, cookie), `x-${crypto.randomUUID()}`))
    expect(unknown.status).toBe(404)
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
