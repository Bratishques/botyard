import { Injectable } from '@nestjs/common'
import { sql } from 'kysely'
import { UnitOfWork } from '../../../shared/database/unit-of-work'
import type { Destination } from '../domain/destination'
import {
  type CheckResult,
  type DestinationChanges,
  DestinationConflict,
  type DestinationRepository,
  type NewDestination,
} from '../domain/ports'

const COLUMNS = [
  'id',
  'name',
  'base_url',
  'api_key_sealed',
  'api_key_hint',
  'project_id',
  'environment_id',
  'server_id',
  'status',
  'last_checked_at',
  'last_error',
  'version',
  'created_at',
  'updated_at',
] as const

type Row = {
  id: string
  name: string
  base_url: string
  api_key_sealed: Uint8Array
  api_key_hint: string
  project_id: string
  environment_id: string
  server_id: string | null
  status: Destination['status']
  last_checked_at: Date | null
  last_error: string | null
  version: number
  created_at: Date
  updated_at: Date
}

/** Ошибка уникальности Postgres → понятный конфликт; имя индекса говорит, что именно занято */
function conflictOf(error: unknown): DestinationConflict | null {
  const pg = error as { code?: string; constraint?: string }
  if (pg.code !== '23505') return null

  return new DestinationConflict(pg.constraint === 'destination_name_uq' ? 'name' : 'target')
}

@Injectable()
export class KyselyDestinationRepository implements DestinationRepository {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  async insert(destination: NewDestination): Promise<Destination> {
    try {
      const row = await this.unitOfWork
        .db()
        .insertInto('destination')
        .values({
          id: destination.id,
          name: destination.name,
          base_url: destination.baseUrl,
          api_key_sealed: destination.apiKeySealed,
          api_key_hint: destination.apiKeyHint,
          project_id: destination.projectId,
          environment_id: destination.environmentId,
          server_id: destination.serverId,
        })
        .returning(COLUMNS)
        .executeTakeFirstOrThrow()

      return toDomain(row)
    } catch (error) {
      throw conflictOf(error) ?? error
    }
  }

  async findById(id: string): Promise<Destination | null> {
    const row = await this.unitOfWork.db().selectFrom('destination').select(COLUMNS).where('id', '=', id).executeTakeFirst()

    return row ? toDomain(row) : null
  }

  async list(): Promise<Destination[]> {
    const rows = await this.unitOfWork.db().selectFrom('destination').select(COLUMNS).orderBy('created_at', 'asc').execute()

    return rows.map(toDomain)
  }

  async update(id: string, expectedVersion: number, changes: DestinationChanges): Promise<Destination | null> {
    try {
      const row = await this.unitOfWork
        .db()
        .updateTable('destination')
        .set({
          ...(changes.name !== undefined && { name: changes.name }),
          ...(changes.baseUrl !== undefined && { base_url: changes.baseUrl }),
          ...(changes.apiKeySealed !== undefined && { api_key_sealed: changes.apiKeySealed }),
          ...(changes.apiKeyHint !== undefined && { api_key_hint: changes.apiKeyHint }),
          ...(changes.projectId !== undefined && { project_id: changes.projectId }),
          ...(changes.environmentId !== undefined && { environment_id: changes.environmentId }),
          ...(changes.serverId !== undefined && { server_id: changes.serverId }),
          ...(changes.status !== undefined && { status: changes.status }),
          version: sql<number>`version + 1`,
          updated_at: new Date(),
        })
        .where('id', '=', id)
        .where('version', '=', expectedVersion)
        .returning(COLUMNS)
        .executeTakeFirst()

      return row ? toDomain(row) : null
    } catch (error) {
      throw conflictOf(error) ?? error
    }
  }

  async recordCheck(id: string, checkedVersion: number, result: CheckResult): Promise<Destination | null> {
    const row = await this.unitOfWork
      .db()
      .updateTable('destination')
      .set({ status: result.status, last_error: result.error, last_checked_at: result.checkedAt })
      .where('id', '=', id)
      .where('version', '=', checkedVersion)
      .where('status', '<>', 'DISABLED')
      .returning(COLUMNS)
      .executeTakeFirst()

    return row ? toDomain(row) : null
  }
}

function toDomain(row: Row): Destination {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    apiKeySealed: row.api_key_sealed,
    apiKeyHint: row.api_key_hint,
    projectId: row.project_id,
    environmentId: row.environment_id,
    serverId: row.server_id,
    status: row.status,
    lastCheckedAt: row.last_checked_at,
    lastError: row.last_error,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
