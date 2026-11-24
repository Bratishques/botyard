import { beforeAll, describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { sql } from 'kysely'
import { SyncCatalog } from '../../src/modules/catalog/application/sync-catalog'
import { FilesystemCatalogSource } from '../../src/modules/catalog/infrastructure/filesystem-catalog.source'
import { PostgresCatalogRepository } from '../../src/modules/catalog/infrastructure/postgres-catalog.repository'
import { CustomerUseCases } from '../../src/modules/customers/application/customer-use-cases'
import { CustomerErrorCode } from '../../src/modules/customers/domain/customer'
import { PostgresCustomerRepository } from '../../src/modules/customers/infrastructure/postgres-customer.repository'
import { DeploymentUseCases } from '../../src/modules/deployments/application/deployment-use-cases'
import { DeploymentErrorCode } from '../../src/modules/deployments/domain/deployment'
import { PostgresDeploymentRepository } from '../../src/modules/deployments/infrastructure/postgres-deployment.repository'
import { AuditLog } from '../../src/shared/audit/audit'
import { loadCatalogConfig } from '../../src/shared/config/config'
import { LocalKeyEncryptionKey } from '../../src/shared/crypto/key-encryption-key'
import { SecretBox } from '../../src/shared/crypto/secret-box'
import { UnitOfWork } from '../../src/shared/database/unit-of-work'
import { Idempotency, IdempotencyConflictError } from '../../src/shared/idempotency/idempotency'
import { Outbox, OutboxTopic } from '../../src/shared/outbox/outbox'
import { db } from './setup'

const unitOfWork = new UnitOfWork(db)
const audit = new AuditLog(unitOfWork)
const deployments = new DeploymentUseCases(new PostgresDeploymentRepository(unitOfWork), unitOfWork, new Outbox(unitOfWork), audit)
const customers = new CustomerUseCases(
  new PostgresCustomerRepository(unitOfWork),
  new SecretBox([new LocalKeyEncryptionKey(1, randomBytes(32))]),
  unitOfWork,
  audit,
)
const idempotency = new Idempotency(unitOfWork)

beforeAll(async () => {
  const source = new FilesystemCatalogSource(loadCatalogConfig().BOTS_CATALOG_DIR)
  await new SyncCatalog(source, new PostgresCatalogRepository(unitOfWork), unitOfWork, audit).execute('system:test')
})

async function customer(): Promise<string> {
  const created = await customers.create(
    { name: `client-${crypto.randomUUID().slice(0, 8)}`, accountId: 'sandbox-account', token: 't.sandbox-token-0123456789abcdef' },
    'operator:1',
  )
  return created.id
}

async function destination(status: 'ACTIVE' | 'DISABLED' = 'ACTIVE'): Promise<string> {
  const id = Bun.randomUUIDv7()
  await db
    .insertInto('destination')
    .values({
      id,
      name: `dest-${id.slice(-8)}`,
      base_url: `https://dokploy-${id.slice(-8)}.example.com`,
      api_key_sealed: new Uint8Array([1]),
      api_key_hint: '••••abcd',
      project_id: 'prj',
      environment_id: `env-${id.slice(-12)}`,
      server_id: null,
      status,
    })
    .execute()
  return id
}

const bitaConfig = { figi: ['BBG004730N88'] }

async function codeOf(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work
    return undefined
  } catch (error) {
    return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : undefined
  }
}

/**
 * Принудительное переплетение: `lock` берёт блокировку в своей транзакции и держит её, `during` стартует и
 * встаёт в ожидание (видно по pg_stat_activity), и только тогда транзакция с блокировкой коммитится.
 */
async function whileLocked<T>(lock: (trx: typeof db) => Promise<unknown>, during: () => Promise<T>): Promise<T> {
  let locked: () => void = () => {}
  let release: () => void = () => {}
  const isLocked = new Promise<void>((resolve) => (locked = resolve))
  const released = new Promise<void>((resolve) => (release = resolve))
  const holder = db.transaction().execute(async (trx) => {
    await lock(trx)
    locked()
    await released
  })
  await isLocked

  const pending = during()
  pending.catch(() => undefined)
  for (let i = 0; i < 200; i++) {
    const waiting = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'
    `.execute(db)
    if ((waiting.rows[0]?.n ?? 0) > 0) break
    await Bun.sleep(10)
  }
  release()
  await holder

  return pending
}

async function running(): Promise<{ id: string; version: number; destinationId: string }> {
  const destinationId = await destination()
  const { deployment } = await deployments.create(
    { customerId: await customer(), destinationId, templateId: 'bita', config: bitaConfig },
    'operator:1',
  )
  // Воркер ещё не написан (шаг 3): завершение provision — прямой записью
  const row = await db
    .updateTable('bot_deployment')
    .set({ status: 'RUNNING', active_operation_id: null, version: sql<number>`version + 1` })
    .where('id', '=', deployment.id)
    .returning('version')
    .executeTakeFirstOrThrow()
  return { id: deployment.id, version: row.version, destinationId }
}

async function disable(destinationId: string, trx: typeof db = db) {
  await trx.updateTable('destination').set({ status: 'DISABLED' }).where('id', '=', destinationId).execute()
}

async function outboxFor(deploymentId: string) {
  return db
    .selectFrom('outbox_message')
    .select(['topic', 'payload'])
    .where(sql<boolean>`payload->>'deploymentId' = ${deploymentId}`)
    .execute()
}

describe('создание развёртывания', () => {
  test('развёртывание, операция PROVISION, команда в outbox и аудит — вместе; умолчания конфига подставлены', async () => {
    const { deployment, operation } = await deployments.create(
      { customerId: await customer(), destinationId: await destination(), templateId: 'bita', config: bitaConfig },
      'operator:1',
    )

    expect(deployment).toMatchObject({ status: 'PROVISIONING', activeOperationId: operation.id, tradingMode: 'sandbox' })
    expect(deployment.appName).toMatch(/^by-[0-9a-f]{12}$/)
    expect(deployment.config).toMatchObject({ figi: ['BBG004730N88'], strategy: 'gamble', logLevel: 'INFO', sellOnExit: false })
    expect(operation).toMatchObject({ kind: 'PROVISION', status: 'PENDING' })
    expect(await outboxFor(deployment.id)).toEqual([
      { topic: 'operation.step', payload: { operationId: operation.id, deploymentId: deployment.id, kind: 'PROVISION' } },
    ])
  })

  test('конфиг не по схеме — понятная ошибка без значений и ничего не записано', async () => {
    const customerId = await customer()
    const before = await db.selectFrom('bot_deployment').select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow()

    const invalid = deployments.create(
      { customerId, destinationId: await destination(), templateId: 'bita', config: { figi: [], strategy: 'SECRET-STRATEGY' } },
      'operator:1',
    )
    await expect(invalid).rejects.toMatchObject({ code: DeploymentErrorCode.INVALID_CONFIG })
    await expect(invalid).rejects.not.toThrow('SECRET-STRATEGY')

    const after = await db.selectFrom('bot_deployment').select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow()
    expect(after.n).toBe(before.n)
  })

  test('выключенное назначение, архивный клиент и неизвестный шаблон — отказ', async () => {
    const customerId = await customer()

    expect(
      await codeOf(
        deployments.create(
          { customerId, destinationId: await destination('DISABLED'), templateId: 'bita', config: bitaConfig },
          'operator:1',
        ),
      ),
    ).toBe(DeploymentErrorCode.DESTINATION_UNAVAILABLE)
    expect(
      await codeOf(deployments.create({ customerId, destinationId: await destination(), templateId: 'nope', config: {} }, 'operator:1')),
    ).toBe(DeploymentErrorCode.TEMPLATE_UNAVAILABLE)
    await customers.archive(customerId, 1, 'operator:1')
    expect(
      await codeOf(
        deployments.create({ customerId, destinationId: await destination(), templateId: 'bita', config: bitaConfig }, 'operator:1'),
      ),
    ).toBe(DeploymentErrorCode.CUSTOMER_UNAVAILABLE)
  })

  test('переплетение: назначение выключают, пока идёт создание — создание видит выключенное и отказывает', async () => {
    const customerId = await customer()
    const destinationId = await destination()

    const outcome = await whileLocked(
      (trx) => disable(destinationId, trx),
      () => codeOf(deployments.create({ customerId, destinationId, templateId: 'bita', config: bitaConfig }, 'operator:1')),
    )

    expect(outcome).toBe(DeploymentErrorCode.DESTINATION_UNAVAILABLE)
  })

  test('переплетение: каталог переключил версию шаблона во время создания — берётся новая, а не «шаблон недоступен»', async () => {
    const current = await db.selectFrom('bot_template').select('current_version').where('id', '=', 'bita').executeTakeFirstOrThrow()
    const next = 'f'.repeat(64)
    await sql`
      INSERT INTO bot_template_version (template_id, version, name, manifest, files)
      SELECT template_id, ${next}, name, manifest, files FROM bot_template_version
      WHERE template_id = 'bita' AND version = ${current.current_version}
      ON CONFLICT DO NOTHING
    `.execute(db)
    const customerId = await customer()
    const destinationId = await destination()

    try {
      const created = await whileLocked(
        (trx) => trx.updateTable('bot_template').set({ current_version: next }).where('id', '=', 'bita').execute(),
        () => deployments.create({ customerId, destinationId, templateId: 'bita', config: bitaConfig }, 'operator:1'),
      )
      expect(created.deployment.templateVersion).toBe(next)
    } finally {
      await db.updateTable('bot_template').set({ current_version: current.current_version }).where('id', '=', 'bita').execute()
    }
  })

  test('команда outbox пишется в транзакции изменения: откат — ни развёртывания, ни команды', async () => {
    const before = await db.selectFrom('outbox_message').select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow()

    await expect(
      unitOfWork.run(async () => {
        await new Outbox(unitOfWork).enqueue(OutboxTopic.OPERATION_STEP, { probe: true })
        throw new Error('rollback')
      }),
    ).rejects.toThrow('rollback')

    const after = await db.selectFrom('outbox_message').select(sql<number>`count(*)::int`.as('n')).executeTakeFirstOrThrow()
    expect(after.n).toBe(before.n)
  })
})

describe('идемпотентность', () => {
  const createOnce = (
    key: string,
    input: { customerId: string; destinationId: string; templateId: string; config: Record<string, unknown> },
  ) =>
    idempotency.run('operator:1:deployments.create', key, input, async () => {
      const created = await deployments.create(input, 'operator:1')
      return { statusCode: 201, response: { id: created.deployment.id } }
    })

  test('повтор с тем же ключом и телом — тот же ответ, одно развёртывание; другое тело — конфликт', async () => {
    const input = { customerId: await customer(), destinationId: await destination(), templateId: 'bita', config: bitaConfig }
    const key = `key-${crypto.randomUUID()}`

    const first = await createOnce(key, input)
    const second = await createOnce(key, input)
    expect(second).toEqual({ ...first, replayed: true })

    await expect(createOnce(key, { ...input, config: { figi: ['OTHER'] } })).rejects.toBeInstanceOf(IdempotencyConflictError)
    const rows = await db.selectFrom('bot_deployment').select('id').where('customer_id', '=', input.customerId).execute()
    expect(rows).toHaveLength(1)
  })

  test('два одновременных запроса с одним ключом — одно развёртывание, оба получают его', async () => {
    const input = { customerId: await customer(), destinationId: await destination(), templateId: 'bita', config: bitaConfig }
    const key = `key-${crypto.randomUUID()}`

    const [a, b] = await Promise.all([createOnce(key, input), createOnce(key, input)])
    expect(a.response).toEqual(b.response)
    const rows = await db.selectFrom('bot_deployment').select('id').where('customer_id', '=', input.customerId).execute()
    expect(rows).toHaveLength(1)
  })
})

describe('операции', () => {
  test('во время provision другая операция не начинается', async () => {
    const { deployment } = await deployments.create(
      { customerId: await customer(), destinationId: await destination(), templateId: 'bita', config: bitaConfig },
      'operator:1',
    )

    expect(await codeOf(deployments.operate(deployment.id, 'DELETE', deployment.version, 'operator:1'))).toBe(
      DeploymentErrorCode.OPERATION_IN_PROGRESS,
    )
  })

  test('гонка двух остановок — одна операция, вторая получает OPERATION_IN_PROGRESS', async () => {
    const { id, version } = await running()

    const results = await Promise.allSettled([
      deployments.operate(id, 'STOP', version, 'operator:1'),
      deployments.operate(id, 'STOP', version, 'operator:2'),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    expect(rejected?.reason).toMatchObject({ code: DeploymentErrorCode.OPERATION_IN_PROGRESS })
    const stops = await db.selectFrom('operation').select('id').where('deployment_id', '=', id).where('kind', '=', 'STOP').execute()
    expect(stops).toHaveLength(1)
  })

  test('недопустимый статус и устаревшая версия — свои коды; удаление переводит в DELETING', async () => {
    const { id, version } = await running()

    expect(await codeOf(deployments.operate(id, 'START', version, 'operator:1'))).toBe(DeploymentErrorCode.INVALID_STATE)
    expect(await codeOf(deployments.operate(id, 'STOP', version - 1, 'operator:1'))).toBe(DeploymentErrorCode.VERSION_CONFLICT)
    const { deployment } = await deployments.operate(id, 'DELETE', version, 'operator:1')
    expect(deployment.status).toBe('DELETING')
    expect((await outboxFor(id)).map((message) => message.payload)).toContainEqual(
      expect.objectContaining({ deploymentId: id, kind: 'DELETE' }),
    )
  })

  test('упавшее удаление (DELETING без активной операции) можно повторить', async () => {
    const { id, version } = await running()
    const { deployment } = await deployments.operate(id, 'DELETE', version, 'operator:1')
    // Воркер не справился с удалением: операция закрыта, развёртывание осталось в DELETING
    await db.updateTable('bot_deployment').set({ active_operation_id: null }).where('id', '=', id).execute()

    const retried = await deployments.operate(id, 'DELETE', deployment.version, 'operator:1')
    expect(retried.deployment.status).toBe('DELETING')
    expect(retried.operation.kind).toBe('DELETE')
  })

  test('на выключенном назначении запуск и передеплой запрещены, остановка и удаление — можно', async () => {
    const { id, version, destinationId } = await running()
    await disable(destinationId)

    expect(await codeOf(deployments.operate(id, 'REDEPLOY', version, 'operator:1'))).toBe(DeploymentErrorCode.DESTINATION_UNAVAILABLE)
    const stopping = await deployments.operate(id, 'STOP', version, 'operator:1')
    expect(stopping.operation.kind).toBe('STOP')

    await db.updateTable('bot_deployment').set({ status: 'STOPPED', active_operation_id: null }).where('id', '=', id).execute()
    expect(await codeOf(deployments.operate(id, 'START', stopping.deployment.version, 'operator:1'))).toBe(
      DeploymentErrorCode.DESTINATION_UNAVAILABLE,
    )
    const deleting = await deployments.operate(id, 'DELETE', stopping.deployment.version, 'operator:1')
    expect(deleting.deployment.status).toBe('DELETING')
  })

  test('переплетение: назначение выключают, пока захватывается передеплой — отказ и захват откатан', async () => {
    const { id, version, destinationId } = await running()

    const outcome = await whileLocked(
      (trx) => disable(destinationId, trx),
      () => codeOf(deployments.operate(id, 'REDEPLOY', version, 'operator:1')),
    )

    expect(outcome).toBe(DeploymentErrorCode.DESTINATION_UNAVAILABLE)
    const after = await db
      .selectFrom('bot_deployment')
      .select(['active_operation_id', 'version'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
    expect(after).toEqual({ active_operation_id: null, version })
  })

  test('одновременные операции с одним ключом идемпотентности — одна операция, одинаковый ответ', async () => {
    const { id, version } = await running()
    const key = `key-${crypto.randomUUID()}`
    const stopOnce = () =>
      idempotency.run(`operator:1:deployments.${id}.operate`, key, { id, kind: 'STOP', version }, async () => {
        const { operation } = await deployments.operate(id, 'STOP', version, 'operator:1')
        return { statusCode: 202, response: { operationId: operation.id } }
      })

    const [a, b] = await Promise.all([stopOnce(), stopOnce()])
    expect(a.response).toEqual(b.response)
    const stops = await db.selectFrom('operation').select('id').where('deployment_id', '=', id).where('kind', '=', 'STOP').execute()
    expect(stops).toHaveLength(1)
  })

  test('активной операцией нельзя сделать операцию чужого развёртывания (составной FK)', async () => {
    const mine = await running()
    const other = await deployments.create(
      { customerId: await customer(), destinationId: await destination(), templateId: 'bita', config: bitaConfig },
      'operator:1',
    )

    await expect(
      db.updateTable('bot_deployment').set({ active_operation_id: other.operation.id }).where('id', '=', mine.id).execute(),
    ).rejects.toThrow()
  })
})

describe('клиент и его развёртывания', () => {
  test('клиента с живым развёртыванием нельзя архивировать', async () => {
    const customerId = await customer()
    await deployments.create({ customerId, destinationId: await destination(), templateId: 'bita', config: bitaConfig }, 'operator:1')

    expect(await codeOf(customers.archive(customerId, 1, 'operator:1'))).toBe(CustomerErrorCode.HAS_DEPLOYMENTS)
  })

  test('режим клиента с живым развёртыванием не переключается; развёртывание помнит свой режим', async () => {
    const customerId = await customer()
    const { deployment } = await deployments.create(
      { customerId, destinationId: await destination(), templateId: 'bita', config: bitaConfig },
      'operator:1',
    )
    const current = await customers.get(customerId)

    expect(
      await codeOf(
        customers.goLive(
          customerId,
          { version: current.version, token: 't.live-token-0123456789abcdef', accountId: 'live-account', confirmName: current.name },
          'operator:1',
        ),
      ),
    ).toBe(CustomerErrorCode.HAS_DEPLOYMENTS)
    expect((await customers.get(customerId)).sandbox).toBe(true)
    expect(deployment.tradingMode).toBe('sandbox')
  })

  test('переплетение: смена режима держит клиента — создание дожидается и берёт новый режим', async () => {
    const customerId = await customer()
    const destinationId = await destination()

    const created = await whileLocked(
      (trx) =>
        trx.updateTable('customer').set({ sandbox: false, version: sql<number>`version + 1` }).where('id', '=', customerId).execute(),
      () => deployments.create({ customerId, destinationId, templateId: 'bita', config: bitaConfig }, 'operator:1'),
    )

    expect(created.deployment.tradingMode).toBe('live')
  })

  test('переплетение: создание держит клиента — смена режима дожидается и получает HAS_DEPLOYMENTS', async () => {
    const customerId = await customer()
    const destinationId = await destination()
    const current = await customers.get(customerId)

    const outcome = await whileLocked(
      async (trx) => {
        await trx.selectFrom('customer').select('id').where('id', '=', customerId).forShare().execute()
        await trx
          .insertInto('bot_deployment')
          .values({
            id: Bun.randomUUIDv7(),
            customer_id: customerId,
            destination_id: destinationId,
            template_id: 'bita',
            template_version: (
              await trx.selectFrom('bot_template').select('current_version').where('id', '=', 'bita').executeTakeFirstOrThrow()
            ).current_version,
            config: '{}',
            trading_mode: 'sandbox',
            app_name: `by-${crypto.randomUUID().replace(/-/g, '').slice(-12)}`,
            status: 'STOPPED',
          })
          .execute()
      },
      () =>
        codeOf(
          customers.goLive(
            customerId,
            { version: current.version, token: 't.live-token-0123456789abcdef', accountId: 'live-account', confirmName: current.name },
            'operator:2',
          ),
        ),
    )

    expect(outcome).toBe(CustomerErrorCode.HAS_DEPLOYMENTS)
  })

  test('гонка: создание развёртывания против перевода клиента в боевой — режим развёртывания всегда равен режиму клиента', async () => {
    for (let round = 0; round < 5; round++) {
      const customerId = await customer()
      const destinationId = await destination()
      const current = await customers.get(customerId)
      const [created, switched] = await Promise.allSettled([
        deployments.create({ customerId, destinationId, templateId: 'bita', config: bitaConfig }, 'operator:1'),
        customers.goLive(
          customerId,
          { version: current.version, token: 't.live-token-0123456789abcdef', accountId: 'live-account', confirmName: current.name },
          'operator:2',
        ),
      ])

      // Переход первым — робот создаётся уже боевым; создание первым — переход отклонён. Песочный робот у боевого
      // клиента (или наоборот) — то, что запрещено
      expect(created.status).toBe('fulfilled')
      const mode = (await customers.get(customerId)).sandbox ? 'sandbox' : 'live'
      if (created.status === 'fulfilled') expect(created.value.deployment.tradingMode).toBe(mode)
      if (switched.status === 'rejected') expect(switched.reason).toMatchObject({ code: CustomerErrorCode.HAS_DEPLOYMENTS })
    }
  })

  test('гонка: создание развёртывания против архивации клиента — никогда не проходят оба', async () => {
    for (let round = 0; round < 5; round++) {
      const customerId = await customer()
      const destinationId = await destination()
      const [created, archived] = await Promise.allSettled([
        deployments.create({ customerId, destinationId, templateId: 'bita', config: bitaConfig }, 'operator:1'),
        customers.archive(customerId, 1, 'operator:2'),
      ])

      expect(created.status === 'fulfilled' && archived.status === 'fulfilled').toBe(false)
      const live = await db.selectFrom('bot_deployment').select('id').where('customer_id', '=', customerId).execute()
      const status = (await customers.get(customerId)).status
      expect(status === 'ARCHIVED' && live.length > 0).toBe(false)
    }
  })
})
