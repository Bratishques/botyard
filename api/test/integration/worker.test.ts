import { beforeAll, describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { sql } from 'kysely'
import { SyncCatalog } from '../../src/modules/catalog/application/sync-catalog'
import { FilesystemCatalogSource } from '../../src/modules/catalog/infrastructure/filesystem-catalog.source'
import { PostgresCatalogRepository } from '../../src/modules/catalog/infrastructure/postgres-catalog.repository'
import { CustomerUseCases } from '../../src/modules/customers/application/customer-use-cases'
import { PostgresCustomerRepository } from '../../src/modules/customers/infrastructure/postgres-customer.repository'
import { DeploymentUseCases } from '../../src/modules/deployments/application/deployment-use-cases'
import { OperationReconciler } from '../../src/modules/deployments/application/operation-reconciler'
import { OperationWorker, type StepMessage } from '../../src/modules/deployments/application/operation-worker'
import {
  type AppSpec,
  type DeploymentPlatform,
  type PlatformApp,
  type PlatformDeployment,
  PlatformError,
  type PlatformTarget,
} from '../../src/modules/deployments/domain/deployment-platform'
import { HandlebarsConfigRenderer } from '../../src/modules/deployments/infrastructure/handlebars-config.renderer'
import { PostgresDeploymentRepository } from '../../src/modules/deployments/infrastructure/postgres-deployment.repository'
import { PostgresOperationStore } from '../../src/modules/deployments/infrastructure/postgres-operation.store'
import { DestinationSecrets } from '../../src/modules/destinations/application/destination-secrets'
import { DestinationUseCases } from '../../src/modules/destinations/application/destination-use-cases'
import type { DokployCatalog } from '../../src/modules/destinations/domain/ports'
import { PostgresDestinationRepository } from '../../src/modules/destinations/infrastructure/postgres-destination.repository'
import { AuditLog } from '../../src/shared/audit/audit'
import { loadCatalogConfig, loadConfig } from '../../src/shared/config/config'
import { LocalKeyEncryptionKey } from '../../src/shared/crypto/key-encryption-key'
import { SecretBox } from '../../src/shared/crypto/secret-box'
import { UnitOfWork } from '../../src/shared/database/unit-of-work'
import { Outbox } from '../../src/shared/outbox/outbox'
import { ROBOT_CA_MOUNT_PATH, TINVEST_ADDRESS } from '../../src/shared/tinvest/tinvest'
import { FakeTradingAccounts } from './fakes'
import { db } from './setup'

const TOKEN = 't.sandbox-token-0123456789abcdef'
const DOKPLOY_KEY = 'dokploy-key-0123456789abcdef'

/**
 * Dokploy в памяти, по поведению живого v0.31.4: create дописывает хвост к appName, деплой ставится
 * в очередь и завершается при опросе. Хуки позволяют «выполнить вызов и потерять ответ» и задержать вызов.
 */
class FakePlatform implements DeploymentPlatform {
  readonly apps = new Map<string, { appName: string; environmentId: string; spec?: AppSpec; running: boolean }>()
  readonly deployments = new Map<string, PlatformDeployment[]>()
  readonly calls: string[] = []
  readonly keys: string[] = []
  /** Метод → ошибка после выполнения (ответ потерян) или вместо него */
  loseAnswer = new Set<string>()
  failBefore = new Map<string, PlatformError>()
  /** Сколько опросов деплой остаётся `running` */
  pollsUntilDone = 1
  deployResult: 'done' | 'error' = 'done'
  createDelay: Promise<void> = Promise.resolve()

  private record(method: string, target: PlatformTarget) {
    this.calls.push(method)
    this.keys.push(target.apiKey)
    const failure = this.failBefore.get(method)
    if (failure) throw failure
  }

  private lost(method: string) {
    if (this.loseAnswer.delete(method)) throw new PlatformError(true, `dokploy ${method}: no answer in 10000 ms`)
  }

  async findApps(target: PlatformTarget, appName: string): Promise<PlatformApp[]> {
    this.record('findApps', target)
    return [...this.apps.entries()]
      .filter(([, app]) => app.environmentId === target.environmentId && app.appName.startsWith(`${appName}-`))
      .map(([id, app]) => ({ id, appName: app.appName }))
  }

  async createApp(target: PlatformTarget, app: { appName: string }): Promise<PlatformApp> {
    this.record('createApp', target)
    await this.createDelay
    const id = `app-${crypto.randomUUID().slice(0, 8)}`
    this.apps.set(id, { appName: `${app.appName}-x1y2z3`, environmentId: target.environmentId, running: false })
    this.lost('createApp')
    return { id, appName: `${app.appName}-x1y2z3` }
  }

  async configure(target: PlatformTarget, appId: string, spec: AppSpec): Promise<void> {
    this.record('configure', target)
    const app = this.apps.get(appId)
    if (!app) throw new PlatformError(false, 'dokploy application.saveGitProvider: 404 Application not found')
    app.spec = spec
  }

  async latestDeployment(target: PlatformTarget, appId: string): Promise<PlatformDeployment | null> {
    this.record('latestDeployment', target)
    const list = this.deployments.get(appId) ?? []
    const latest = list.at(-1)
    if (latest?.status === 'running') {
      if (this.pollsUntilDone <= 0) list[list.length - 1] = { ...latest, status: this.deployResult }
      else this.pollsUntilDone--
    }
    return list.at(-1) ?? null
  }

  async deploy(target: PlatformTarget, appId: string): Promise<void> {
    this.record('deploy', target)
    const list = this.deployments.get(appId) ?? []
    list.push({ id: `dep-${list.length + 1}`, status: 'running' })
    this.deployments.set(appId, list)
    this.lost('deploy')
  }

  async start(target: PlatformTarget, appId: string): Promise<void> {
    this.record('start', target)
    const app = this.apps.get(appId)
    if (app) app.running = true
  }

  async stop(target: PlatformTarget, appId: string): Promise<void> {
    this.record('stop', target)
    const app = this.apps.get(appId)
    if (app) app.running = false
  }

  /** Удаление «прошло», а приложение осталось (Dokploy ответил 200, но не удалил) */
  keepOnDelete = false

  async deleteApp(target: PlatformTarget, appId: string): Promise<void> {
    this.record('deleteApp', target)
    if (!this.keepOnDelete) this.apps.delete(appId)
  }
}

const unitOfWork = new UnitOfWork(db)
const audit = new AuditLog(unitOfWork)
const box = new SecretBox([new LocalKeyEncryptionKey(1, randomBytes(32))])
const outbox = new Outbox(unitOfWork)
const store = new PostgresOperationStore(unitOfWork)
const customers = new CustomerUseCases(new PostgresCustomerRepository(unitOfWork), box, unitOfWork, audit, new FakeTradingAccounts())
const destinationSecrets = new DestinationSecrets(box)
const unusedCatalog: DokployCatalog = {
  environments: async () => [],
  applicationIds: async () => new Set<string>(),
  servers: async () => [],
}
const destinations = new DestinationUseCases(
  new PostgresDestinationRepository(unitOfWork),
  unusedCatalog,
  loadConfig(),
  destinationSecrets,
  unitOfWork,
  audit,
)
const deployments = new DeploymentUseCases(new PostgresDeploymentRepository(unitOfWork), unitOfWork, outbox, audit)

function workerWith(platform: DeploymentPlatform): OperationWorker {
  return new OperationWorker(
    store,
    new PostgresDeploymentRepository(unitOfWork),
    platform,
    new HandlebarsConfigRenderer(),
    new PostgresCatalogRepository(unitOfWork),
    customers,
    destinations,
    unitOfWork,
    outbox,
    audit,
  )
}

beforeAll(async () => {
  const source = new FilesystemCatalogSource(loadCatalogConfig().BOTS_CATALOG_DIR)
  await new SyncCatalog(source, new PostgresCatalogRepository(unitOfWork), unitOfWork, audit).execute('system:test')
})

async function destination(): Promise<{ id: string; environmentId: string }> {
  const id = Bun.randomUUIDv7()
  const baseUrl = `https://dokploy-${id.slice(-8)}.example.com`
  const environmentId = `env-${id.slice(-12)}`
  const { sealed, hint } = await destinationSecrets.seal(id, baseUrl, DOKPLOY_KEY)
  await db
    .insertInto('destination')
    .values({
      id,
      name: `w-${id.slice(-8)}`,
      base_url: baseUrl,
      api_key_sealed: sealed,
      api_key_hint: hint,
      project_id: 'prj',
      environment_id: environmentId,
      server_id: null,
    })
    .execute()
  return { id, environmentId }
}

async function provision(templateId = 'bita', config: Record<string, unknown> = { figi: ['BBG004730N88'] }) {
  const customer = await customers.create(
    { name: `w-${crypto.randomUUID().slice(0, 8)}`, accountId: 'sandbox-acc', token: TOKEN },
    'operator:1',
  )
  const target = await destination()
  const created = await deployments.create({ customerId: customer.id, destinationId: target.id, templateId, config }, 'operator:1')
  return { ...created, customer, target }
}

/** Команды операции, ещё не отданные «брокеру» */
async function pending(operationId: string): Promise<{ id: string; message: StepMessage }[]> {
  const rows = await db
    .selectFrom('outbox_message')
    .select(['id', 'payload'])
    .where('published_at', 'is', null)
    .where(sql<boolean>`payload->>'operationId' = ${operationId}`)
    .orderBy('id')
    .execute()

  return rows.map((row) => ({ id: row.id, message: stepMessage(row.payload) }))
}

function stepMessage(payload: Record<string, unknown>): StepMessage {
  const { operationId, deploymentId, kind, step, wake } = payload
  if (typeof operationId !== 'string' || typeof deploymentId !== 'string' || typeof kind !== 'string' || typeof step !== 'string') {
    throw new Error('not a step message')
  }
  return { operationId, deploymentId, kind, step, ...(typeof wake === 'string' && { wake }) }
}

/** Relay и брокер в одном: отдать воркеру всё, что лежит в outbox, пока команды не кончатся (паузы не ждём) */
async function drive(worker: OperationWorker, operationId: string, limit = 50): Promise<StepMessage[]> {
  const delivered: StepMessage[] = []
  for (let i = 0; i < limit; i++) {
    const [next] = await pending(operationId)
    if (!next) return delivered
    await db.updateTable('outbox_message').set({ published_at: new Date() }).where('id', '=', next.id).execute()
    delivered.push(next.message)
    await worker.handle(next.message)
  }
  throw new Error('saga did not settle')
}

async function state(deploymentId: string, operationId: string) {
  const deployment = await db
    .selectFrom('bot_deployment')
    .select(['status', 'dokploy_app_id', 'active_operation_id', 'last_error'])
    .where('id', '=', deploymentId)
    .executeTakeFirstOrThrow()
  const operation = await db
    .selectFrom('operation')
    .select(['status', 'step', 'error', 'lease_until'])
    .where('id', '=', operationId)
    .executeTakeFirstOrThrow()
  return { deployment, operation }
}

async function running(platform: FakePlatform) {
  const created = await provision()
  await drive(workerWith(platform), created.operation.id)
  const { version } = await db
    .selectFrom('bot_deployment')
    .select('version')
    .where('id', '=', created.deployment.id)
    .executeTakeFirstOrThrow()
  return { ...created, version }
}

describe('воркер саги: provision', () => {
  test('приложение, конфиг с токеном и корнем сертификатов, деплой и ожидание — развёртывание RUNNING', async () => {
    const platform = new FakePlatform()
    platform.pollsUntilDone = 2
    const { deployment, operation, target } = await provision()

    const delivered = await drive(workerWith(platform), operation.id)

    expect(delivered.map((message) => message.step)).toEqual([
      'ensure_app',
      'configure',
      'prepare_deploy',
      'deploy',
      'await_deploy',
      'await_deploy',
      'await_deploy',
    ])
    const { deployment: after, operation: op } = await state(deployment.id, operation.id)
    const [appId, app] = [...platform.apps.entries()][0] ?? []
    expect(after).toEqual({ status: 'RUNNING', dokploy_app_id: appId ?? null, active_operation_id: null, last_error: null })
    expect(op).toMatchObject({ status: 'SUCCEEDED', error: null, lease_until: null })
    expect(app?.environmentId).toBe(target.environmentId)
    expect(app?.spec?.runtime.env).toMatchObject({ TRADEBOT_TOKEN: TOKEN, TRADEBOT_IS_SANDBOX: 'true', SSL_CERT_FILE: ROBOT_CA_MOUNT_PATH })
    expect(app?.spec?.source).toEqual({ gitUrl: 'https://github.com/elkopass/BITA.git', ref: 'main' })
    expect(new Set(platform.keys)).toEqual(new Set([DOKPLOY_KEY]))
    const events = await db.selectFrom('audit_event').select(['action', 'payload']).where('target_id', '=', deployment.id).execute()
    expect(events.map((event) => event.action)).toContain('deployment.provision_succeeded')
    expect(JSON.stringify(events)).not.toContain(TOKEN)
  })

  test('файл конфига робота: TOML с адресом T-Invest по режиму развёртывания', async () => {
    const platform = new FakePlatform()
    const { operation } = await provision('contest-2022', { instruments: [{ figi: 'BBG004730N88' }] })

    await drive(workerWith(platform), operation.id)

    const files = [...platform.apps.values()][0]?.spec?.runtime.files ?? []
    expect(files.map((file) => file.mountPath)).toEqual([ROBOT_CA_MOUNT_PATH, '/opt/tinkoff-invest-robot-contest-2022/configs/config.toml'])
    expect(files[1]?.content).toContain(`address = "${TINVEST_ADDRESS.sandbox}"`)
  })

  test('ответ на create потерян — повтор находит приложение поиском, второго не создаёт', async () => {
    const platform = new FakePlatform()
    platform.loseAnswer.add('createApp')
    const { deployment, operation } = await provision()

    await drive(workerWith(platform), operation.id)

    expect(platform.apps.size).toBe(1)
    expect(platform.calls.filter((call) => call === 'createApp')).toHaveLength(1)
    // Повтор поиска — не сразу: create без ответа мог ещё не завершиться в Dokploy
    const retry = await db
      .selectFrom('outbox_message')
      .select(sql<number>`extract(epoch from available_at - created_at)`.as('delay'))
      .where(sql<boolean>`payload->>'operationId' = ${operation.id}`)
      .where(sql<boolean>`payload->>'step' = 'ensure_app'`)
      .where(sql<boolean>`payload ? 'wake'`)
      .executeTakeFirstOrThrow()
    expect(Number(retry.delay)).toBeGreaterThanOrEqual(15)
    expect((await state(deployment.id, operation.id)).deployment.status).toBe('RUNNING')
  })

  test('ответ на deploy потерян — повтор видит новый деплой и второй не запускает', async () => {
    const platform = new FakePlatform()
    platform.loseAnswer.add('deploy')
    const { deployment, operation } = await provision()

    await drive(workerWith(platform), operation.id)

    expect(platform.calls.filter((call) => call === 'deploy')).toHaveLength(1)
    expect((await state(deployment.id, operation.id)).deployment.status).toBe('RUNNING')
  })

  test('сборка упала в Dokploy — операция FAILED с понятной причиной, захват снят', async () => {
    const platform = new FakePlatform()
    platform.deployResult = 'error'
    const { deployment, operation } = await provision()

    await drive(workerWith(platform), operation.id)

    const result = await state(deployment.id, operation.id)
    expect(result.deployment).toMatchObject({ status: 'FAILED', active_operation_id: null })
    expect(result.deployment.last_error).toContain('ended with error')
    expect(result.operation.status).toBe('FAILED')
  })

  test('ключ Dokploy не принят — отказ без повторов; временная ошибка — повторы до предела', async () => {
    const rejected = new FakePlatform()
    rejected.failBefore.set('findApps', new PlatformError(false, 'dokploy application.search: 401 Unauthorized'))
    const first = await provision()
    await drive(workerWith(rejected), first.operation.id)
    expect(rejected.calls).toEqual(['findApps'])
    expect((await state(first.deployment.id, first.operation.id)).operation.error).toContain('401')

    const down = new FakePlatform()
    down.failBefore.set('findApps', new PlatformError(true, 'dokploy application.search: 503'))
    const second = await provision()
    await drive(workerWith(down), second.operation.id)
    expect(down.calls).toHaveLength(6)
    expect((await state(second.deployment.id, second.operation.id)).operation.error).toContain('gave up after 6 attempts')
  })
})

describe('воркер саги: гонки и повторная доставка', () => {
  test('дубль шага во время аренды — Dokploy вызывается один раз, дубль отложен до конца аренды', async () => {
    const platform = new FakePlatform()
    let release: () => void = () => {}
    platform.createDelay = new Promise((resolve) => (release = resolve))
    const { operation } = await provision()
    const [first] = await pending(operation.id)
    if (!first) throw new Error('no command')
    await db.updateTable('outbox_message').set({ published_at: new Date() }).where('id', '=', first.id).execute()
    const worker = workerWith(platform)

    const original = worker.handle(first.message)
    while (!platform.calls.includes('createApp')) await Bun.sleep(5)
    await worker.handle(first.message)
    release()
    await original

    expect(platform.calls.filter((call) => call === 'createApp')).toHaveLength(1)
    const deferred = await db
      .selectFrom('outbox_message')
      .select(['payload', sql<boolean>`available_at > now() + interval '30 seconds'`.as('later')])
      .where(sql<boolean>`payload->>'operationId' = ${operation.id}`)
      .where(sql<boolean>`payload->>'step' = 'ensure_app'`)
      .where('published_at', 'is', null)
      .execute()
    expect(deferred).toEqual([expect.objectContaining({ later: true })])
  })

  test('отложенная команда одноразова: старый и повторный wake после паузы — устаревшие', async () => {
    const platform = new FakePlatform()
    platform.pollsUntilDone = 5
    const { operation } = await provision()
    const worker = workerWith(platform)
    const delivered: StepMessage[] = []
    // До первого ожидания деплоя
    for (;;) {
      const [next] = await pending(operation.id)
      if (!next) throw new Error('no command')
      await db.updateTable('outbox_message').set({ published_at: new Date() }).where('id', '=', next.id).execute()
      delivered.push(next.message)
      await worker.handle(next.message)
      if (next.message.step === 'await_deploy') break
    }
    const [waked] = await pending(operation.id)
    if (!waked?.message.wake) throw new Error('expected a delayed command with a wake mark')

    const polls = () => platform.calls.filter((call) => call === 'latestDeployment').length
    const before = polls()
    await worker.handle(delivered.at(-1) ?? waked.message) // первая команда ожидания пришла второй раз
    expect(polls()).toBe(before)

    await db.updateTable('outbox_message').set({ published_at: new Date() }).where('id', '=', waked.id).execute()
    await worker.handle(waked.message)
    await worker.handle(waked.message) // дубль того же пробуждения
    expect(polls()).toBe(before + 1)
  })

  test('опоздавший воркер ничего не пишет и после того, как ожидание сбросило номер попытки (ABA)', async () => {
    const { operation } = await provision()
    await db.updateTable('operation').set({ step: 'await_deploy' }).where('id', '=', operation.id).execute()
    const late = await store.claim(operation.id, 'await_deploy', null, 60_000)
    if ('reason' in late) throw new Error('not claimed')
    const expire = () =>
      db.updateTable('operation').set({ lease_until: sql<Date>`now() - interval '1 second'` }).where('id', '=', operation.id).execute()

    await expire()
    const second = await store.claim(operation.id, 'await_deploy', null, 60_000)
    if ('reason' in second) throw new Error('not claimed')
    expect(await store.release(second, {}, 'wake-1', { resetAttempts: true })).toBe(true)
    const third = await store.claim(operation.id, 'await_deploy', 'wake-1', 60_000)
    if ('reason' in third) throw new Error('not claimed')
    expect(third.attempt).toBe(late.attempt)

    expect(await store.release(late, {}, 'wake-late', { resetAttempts: true })).toBe(false)
    const row = await db.selectFrom('operation').select(['lease_until', 'context']).where('id', '=', operation.id).executeTakeFirstOrThrow()
    expect(row.lease_until).not.toBeNull()
    expect(row.context).toMatchObject({ wakeNonce: 'wake-1' })
  })

  test('аренда истекла между попыткой захвата и проверкой причины — захват повторяется, команда не теряется', async () => {
    const { operation } = await provision()
    const racing = new (class extends PostgresOperationStore {
      private missed = false
      protected override async tryClaim(...args: Parameters<PostgresOperationStore['tryClaim']>) {
        if (!this.missed) {
          this.missed = true
          return null
        }
        return super.tryClaim(...args)
      }
    })(unitOfWork)

    const claimed = await racing.claim(operation.id, 'ensure_app', null, 60_000)

    expect('reason' in claimed).toBe(false)
  })

  test('воркер, у которого истекла аренда и шаг взял другой, ничего не записывает', async () => {
    const { operation } = await provision()
    const mine = await store.claim(operation.id, 'ensure_app', null, 60_000)
    if ('reason' in mine) throw new Error('not claimed')
    await db.updateTable('operation').set({ lease_until: sql<Date>`now() - interval '1 second'` }).where('id', '=', operation.id).execute()
    const theirs = await store.claim(operation.id, 'ensure_app', null, 60_000)
    if ('reason' in theirs) throw new Error('not claimed')

    expect(await store.advance(mine, 'configure', {})).toBe(false)
    expect(await store.finish(mine, { operation: 'FAILED', error: 'late', deploymentStatus: 'FAILED' })).toBe(false)
    expect(await store.advance(theirs, 'configure', {})).toBe(true)
  })

  test('режим клиента сменили в обход сценария — configure отказывает, токен не уходит', async () => {
    const platform = new FakePlatform()
    const { deployment, operation, customer } = await provision()
    await db.updateTable('customer').set({ sandbox: false }).where('id', '=', customer.id).execute()

    await drive(workerWith(platform), operation.id)

    expect(platform.calls).not.toContain('configure')
    expect((await state(deployment.id, operation.id)).operation.error).toContain('created for sandbox')
  })

  test('назначение выключили после запроса запуска — start отказывает; stop и delete проходят', async () => {
    const platform = new FakePlatform()
    const { deployment, target, version } = await running(platform)
    const stopped = await deployments.operate(deployment.id, 'STOP', version, 'operator:1')
    await drive(workerWith(platform), stopped.operation.id)

    const { version: afterStop } = await db
      .selectFrom('bot_deployment')
      .select('version')
      .where('id', '=', deployment.id)
      .executeTakeFirstOrThrow()
    const start = await deployments.operate(deployment.id, 'START', afterStop, 'operator:1')
    await db.updateTable('destination').set({ status: 'DISABLED' }).where('id', '=', target.id).execute()
    await drive(workerWith(platform), start.operation.id)
    expect((await state(deployment.id, start.operation.id)).operation.error).toBe('the destination is disabled')
    expect(platform.calls).not.toContain('start')

    const { version: afterStart } = await db
      .selectFrom('bot_deployment')
      .select('version')
      .where('id', '=', deployment.id)
      .executeTakeFirstOrThrow()
    const removal = await deployments.operate(deployment.id, 'DELETE', afterStart, 'operator:1')
    await drive(workerWith(platform), removal.operation.id)
    expect((await state(deployment.id, removal.operation.id)).deployment).toMatchObject({ status: 'DELETED', dokploy_app_id: null })
    expect(platform.apps.size).toBe(0)
  })

  test('назначение выключили, пока деплой уже идёт, — операция не падает: робот в Dokploy запустится', async () => {
    const platform = new FakePlatform()
    platform.pollsUntilDone = 1
    const { deployment, operation, target } = await provision()
    const worker = workerWith(platform)
    for (;;) {
      const [next] = await pending(operation.id)
      if (!next) throw new Error('no command')
      await db.updateTable('outbox_message').set({ published_at: new Date() }).where('id', '=', next.id).execute()
      await worker.handle(next.message)
      if (next.message.step === 'deploy') break
    }

    await db.updateTable('destination').set({ status: 'DISABLED' }).where('id', '=', target.id).execute()
    await drive(worker, operation.id)

    expect((await state(deployment.id, operation.id)).deployment.status).toBe('RUNNING')
  })

  test('redeploy: то же приложение, конфиг перерисован, новый деплой; второго приложения нет', async () => {
    const platform = new FakePlatform()
    const { deployment, version } = await running(platform)
    const [appId] = [...platform.apps.keys()]
    if (!appId) throw new Error('no app after provision')

    const redeploy = await deployments.operate(deployment.id, 'REDEPLOY', version, 'operator:1')
    await drive(workerWith(platform), redeploy.operation.id)

    expect([...platform.apps.keys()]).toEqual([appId])
    expect(platform.calls.filter((call) => call === 'configure')).toHaveLength(2)
    expect(platform.deployments.get(appId)?.map((item) => item.status)).toEqual(['done', 'done'])
    expect((await state(deployment.id, redeploy.operation.id)).deployment.status).toBe('RUNNING')
  })

  test('start, который не сходится (робот падает при запуске), — две попытки, FAILED с подсказкой; затем stop из FAILED', async () => {
    const platform = new FakePlatform()
    const { deployment, version } = await running(platform)
    const stop = await deployments.operate(deployment.id, 'STOP', version, 'operator:1')
    await drive(workerWith(platform), stop.operation.id)
    const afterStop = (await db.selectFrom('bot_deployment').select('version').where('id', '=', deployment.id).executeTakeFirstOrThrow())
      .version

    platform.failBefore.set('start', new PlatformError(true, 'dokploy application.start: no answer in 30000 ms'))
    const start = await deployments.operate(deployment.id, 'START', afterStop, 'operator:1')
    await drive(workerWith(platform), start.operation.id)
    expect(platform.calls.filter((call) => call === 'start')).toHaveLength(2)
    const failed = await state(deployment.id, start.operation.id)
    expect(failed.deployment.status).toBe('FAILED')
    expect(failed.operation.error).toContain('the robot may be crashing on start')

    const afterStart = (await db.selectFrom('bot_deployment').select('version').where('id', '=', deployment.id).executeTakeFirstOrThrow())
      .version
    const rescue = await deployments.operate(deployment.id, 'STOP', afterStart, 'operator:1')
    await drive(workerWith(platform), rescue.operation.id)
    expect((await state(deployment.id, rescue.operation.id)).deployment.status).toBe('STOPPED')
  })

  test('текст ошибки Dokploy с токеном и ключом не попадает в операцию и аудит', async () => {
    const platform = new FakePlatform()
    platform.failBefore.set(
      'configure',
      new PlatformError(
        false,
        `dokploy mounts.create: 400 Error Failed query: insert into mount params: token = "${TOKEN}", key ${DOKPLOY_KEY}`,
      ),
    )
    const { deployment, operation } = await provision()

    await drive(workerWith(platform), operation.id)

    const stored = await state(deployment.id, operation.id)
    expect(stored.operation.error).toContain('<secret>')
    expect(JSON.stringify(stored)).not.toContain(TOKEN)
    expect(JSON.stringify(stored)).not.toContain(DOKPLOY_KEY)
    const audit = await db.selectFrom('audit_event').select('payload').where('target_id', '=', deployment.id).execute()
    expect(JSON.stringify(audit)).not.toContain(TOKEN)
  })

  test('после удаления приложение всё ещё находится — не DELETED: повторы, затем удаление можно повторить', async () => {
    const platform = new FakePlatform()
    const { deployment, version } = await running(platform)
    platform.keepOnDelete = true

    const removal = await deployments.operate(deployment.id, 'DELETE', version, 'operator:1')
    await drive(workerWith(platform), removal.operation.id)

    const result = await state(deployment.id, removal.operation.id)
    expect(result.deployment.status).toBe('DELETING')
    expect(result.operation.error).toContain('still present after delete')
  })

  test('ответ на deploy потерян, затем назначение выключили — повтор видит запущенный деплой и доводит до конца', async () => {
    const platform = new FakePlatform()
    platform.loseAnswer.add('deploy')
    const { deployment, operation, target } = await provision()
    const worker = workerWith(platform)
    for (;;) {
      const [next] = await pending(operation.id)
      if (!next) throw new Error('no command')
      await db.updateTable('outbox_message').set({ published_at: new Date() }).where('id', '=', next.id).execute()
      await worker.handle(next.message)
      if (next.message.step === 'deploy') break
    }

    await db.updateTable('destination').set({ status: 'DISABLED' }).where('id', '=', target.id).execute()
    await drive(worker, operation.id)

    expect(platform.calls.filter((call) => call === 'deploy')).toHaveLength(1)
    expect((await state(deployment.id, operation.id)).deployment.status).toBe('RUNNING')
  })

  test('удаление находит и приложение, созданное без ответа (по appName), — удаляются оба следа', async () => {
    const platform = new FakePlatform()
    const { deployment, version } = await running(platform)
    // Второе приложение с тем же appName — как после потерянного ответа create
    platform.apps.set('app-orphan', {
      appName: `${deployment.appName}-q9w8e7`,
      environmentId: [...platform.apps.values()][0]?.environmentId ?? '',
      running: false,
    })

    const removal = await deployments.operate(deployment.id, 'DELETE', version, 'operator:1')
    await drive(workerWith(platform), removal.operation.id)

    expect(platform.apps.size).toBe(0)
  })

  test('операцию сняли с развёртывания (захват очищен руками) — шаг не трогает Dokploy и развёртывание', async () => {
    const platform = new FakePlatform()
    const { deployment, operation } = await provision()
    await db.updateTable('bot_deployment').set({ active_operation_id: null, status: 'FAILED' }).where('id', '=', deployment.id).execute()

    await drive(workerWith(platform), operation.id)

    expect(platform.calls).toEqual([])
    const result = await state(deployment.id, operation.id)
    expect(result.operation).toMatchObject({ status: 'FAILED', error: 'the operation is no longer active for this deployment' })
    expect(result.deployment.status).toBe('FAILED')
  })

  test('шаг с неизвестным именем и сообщение по завершённой операции отбрасываются', async () => {
    const platform = new FakePlatform()
    const { deployment, operation } = await running(platform)
    const worker = workerWith(platform)
    const calls = platform.calls.length

    await worker.handle({ operationId: operation.id, deploymentId: deployment.id, kind: 'PROVISION', step: 'format_disk' })
    await worker.handle({ operationId: operation.id, deploymentId: deployment.id, kind: 'PROVISION', step: 'ensure_app' })

    expect(platform.calls.length).toBe(calls)
    expect(await pending(operation.id)).toEqual([])
  })
})

describe('reconciler застрявших операций', () => {
  const reconciler = new OperationReconciler(store, unitOfWork, outbox, audit)
  /** Команда потеряна: сообщения в outbox нет, операция без движения дольше порога */
  async function loseCommand(operationId: string, minutesAgo = 11) {
    await db.deleteFrom('outbox_message').where(sql<boolean>`payload->>'operationId' = ${operationId}`).execute()
    await sql`UPDATE operation SET updated_at = now() - make_interval(mins => ${minutesAgo}) WHERE id = ${operationId}`.execute(db)
  }

  test('потерянная команда: пинок с новой меткой — операция доходит до конца, старая команда устарела', async () => {
    const platform = new FakePlatform()
    const { deployment, operation } = await provision()
    const original: StepMessage = { operationId: operation.id, deploymentId: deployment.id, kind: 'PROVISION', step: 'ensure_app' }
    await loseCommand(operation.id)

    const result = await reconciler.tick()
    expect(result.kicked).toBeGreaterThanOrEqual(1)
    const [command] = await pending(operation.id)
    expect(command?.message).toMatchObject({ step: 'ensure_app', wake: expect.any(String) })

    await workerWith(platform).handle(original) // старая команда всё-таки доехала
    expect(platform.calls).toEqual([])
    await drive(workerWith(platform), operation.id)
    expect((await state(deployment.id, operation.id)).deployment.status).toBe('RUNNING')
    const context = await db.selectFrom('operation').select('context').where('id', '=', operation.id).executeTakeFirstOrThrow()
    expect(context.context).not.toHaveProperty('kicks')
  })

  test('операцию с живой арендой или недавним движением не трогает', async () => {
    const busy = await provision()
    await loseCommand(busy.operation.id)
    await sql`UPDATE operation SET status = 'RUNNING', lease_until = now() + interval '1 minute' WHERE id = ${busy.operation.id}`.execute(
      db,
    )
    const fresh = await provision()
    await loseCommand(fresh.operation.id, 1)

    await reconciler.tick()

    expect(await pending(busy.operation.id)).toEqual([])
    expect(await pending(fresh.operation.id)).toEqual([])
  })

  test('после трёх пинков без прогресса — FAILED с причиной, захват снят, аудит от reconciler', async () => {
    const { deployment, operation } = await provision()
    await loseCommand(operation.id)
    await sql`UPDATE operation SET context = context || '{"kicks": 3}'::jsonb WHERE id = ${operation.id}`.execute(db)

    const result = await reconciler.tick()

    expect(result.abandoned).toBeGreaterThanOrEqual(1)
    const after = await state(deployment.id, operation.id)
    expect(after.operation).toMatchObject({ status: 'FAILED' })
    expect(after.operation.error).toContain('no progress on step ensure_app after 3 restarts')
    expect(after.deployment).toMatchObject({ status: 'FAILED', active_operation_id: null })
    const events = await db.selectFrom('audit_event').select(['actor', 'action']).where('target_id', '=', deployment.id).execute()
    expect(events).toContainEqual({ actor: 'system:reconciler', action: 'deployment.provision_failed' })
  })

  test('гонка: воркер взял шаг между чтением и пинком — пинок не проходит, команда не дублируется', async () => {
    const { operation } = await provision()
    await loseCommand(operation.id)
    const [stalled] = (await store.stalled(10 * 60_000, 500)).filter((item) => item.operationId === operation.id)
    if (!stalled) throw new Error('not stalled')

    const claimed = await store.claim(operation.id, 'ensure_app', null, 60_000)
    expect('reason' in claimed).toBe(false)

    expect(await store.kick(stalled, 'late-wake', 10 * 60_000)).toBe(false)
    expect(await store.abandon(stalled, { operation: 'FAILED', error: 'late', deploymentStatus: 'FAILED' }, 10 * 60_000)).toBe(false)
  })

  test('команда в заторе outbox (relay стоит) — операция не застряла, не будится', async () => {
    const { operation } = await provision()
    // Команда не потеряна: лежит неопубликованной, операция давно без движения
    await sql`UPDATE operation SET updated_at = now() - interval '40 minutes' WHERE id = ${operation.id}`.execute(db)

    await reconciler.tick()

    expect(await pending(operation.id)).toHaveLength(1)
    const row = await db.selectFrom('operation').select('context').where('id', '=', operation.id).executeTakeFirstOrThrow()
    expect(row.context).not.toHaveProperty('kicks')
  })

  test('деплой уже идёт в Dokploy — после всех пинков не FAILED, а снова пинок', async () => {
    const { deployment, operation } = await provision()
    await loseCommand(operation.id)
    await sql`UPDATE operation SET step = 'await_deploy', context = '{"kicks": 3, "baselineDeploymentId": null, "deployRequestedAt": "2026-11-24T00:00:00Z"}'::jsonb WHERE id = ${operation.id}`.execute(
      db,
    )

    const result = await reconciler.tick()

    expect(result.abandoned).toBe(0)
    expect((await state(deployment.id, operation.id)).operation.status).not.toBe('FAILED')
    expect((await pending(operation.id)).map((item) => item.message.step)).toEqual(['await_deploy'])
  })

  test('опоздавший release воркера не стирает счётчик пинков', async () => {
    const { operation } = await provision()
    const claimed = await store.claim(operation.id, 'ensure_app', null, 60_000)
    if ('reason' in claimed) throw new Error('not claimed')
    await sql`UPDATE operation SET context = context || '{"kicks": 2}'::jsonb WHERE id = ${operation.id}`.execute(db)

    expect(await store.release(claimed, { ...claimed.context }, 'wake-x', { resetAttempts: false })).toBe(true)

    const row = await db.selectFrom('operation').select('context').where('id', '=', operation.id).executeTakeFirstOrThrow()
    expect(row.context).toMatchObject({ kicks: 2, wakeNonce: 'wake-x' })
  })

  test('гонка: воркер отпустил шаг на повтор между чтением и пинком — пинок не перебивает его паузу', async () => {
    const { operation } = await provision()
    await loseCommand(operation.id)
    const [stalled] = (await store.stalled(10 * 60_000, 500)).filter((item) => item.operationId === operation.id)
    if (!stalled) throw new Error('not stalled')

    // Воркер взял шаг и тут же отпустил его на повтор с паузой: аренды нет, пинков столько же, но движение свежее
    const claimed = await store.claim(operation.id, 'ensure_app', null, 60_000)
    if ('reason' in claimed) throw new Error('not claimed')
    expect(await store.release(claimed, {}, 'worker-wake', { resetAttempts: false })).toBe(true)

    expect(await store.kick(stalled, 'late-wake', 10 * 60_000)).toBe(false)
    const row = await db.selectFrom('operation').select('context').where('id', '=', operation.id).executeTakeFirstOrThrow()
    expect(row.context).toMatchObject({ wakeNonce: 'worker-wake' })
  })

  test('два reconciler одновременно — одна операция будится один раз', async () => {
    const { operation } = await provision()
    await loseCommand(operation.id)

    await Promise.all([reconciler.tick(), new OperationReconciler(store, unitOfWork, outbox, audit).tick()])

    expect(await pending(operation.id)).toHaveLength(1)
    const row = await db.selectFrom('operation').select('context').where('id', '=', operation.id).executeTakeFirstOrThrow()
    expect(row.context).toMatchObject({ kicks: 1 })
  })
})
