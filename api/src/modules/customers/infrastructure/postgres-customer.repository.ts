import { Injectable } from '@nestjs/common'
import { type Selectable, sql } from 'kysely'
import { isUniqueViolation } from '../../../shared/database/pg-errors'
import type { CustomerTable } from '../../../shared/database/schema'
import { UnitOfWork } from '../../../shared/database/unit-of-work'
import {
  type Customer,
  type CustomerChanges,
  CustomerError,
  CustomerErrorCode,
  type CustomerRepository,
  type NewCustomer,
} from '../domain/customer'

const COLUMNS = [
  'id',
  'name',
  'account_id',
  'tinvest_token_sealed',
  'tinvest_token_hint',
  'sandbox',
  'status',
  'version',
  'created_at',
  'updated_at',
] as const

@Injectable()
export class PostgresCustomerRepository implements CustomerRepository {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  async insert(customer: NewCustomer): Promise<Customer> {
    try {
      const row = await this.unitOfWork
        .db()
        .insertInto('customer')
        .values({
          id: customer.id,
          name: customer.name,
          account_id: customer.accountId,
          tinvest_token_sealed: customer.tokenSealed,
          tinvest_token_hint: customer.tokenHint,
        })
        .returning(COLUMNS)
        .executeTakeFirstOrThrow()

      return toDomain(row)
    } catch (error) {
      throw nameTaken(error) ?? error
    }
  }

  async findById(id: string): Promise<Customer | null> {
    const row = await this.unitOfWork.db().selectFrom('customer').select(COLUMNS).where('id', '=', id).executeTakeFirst()

    return row ? toDomain(row) : null
  }

  async list(): Promise<Customer[]> {
    return (await this.unitOfWork.db().selectFrom('customer').select(COLUMNS).orderBy('created_at').execute()).map(toDomain)
  }

  async update(id: string, expectedVersion: number, changes: CustomerChanges): Promise<Customer | null> {
    try {
      const row = await this.unitOfWork
        .db()
        .updateTable('customer')
        .set({
          ...(changes.name !== undefined && { name: changes.name }),
          ...(changes.accountId !== undefined && { account_id: changes.accountId }),
          ...(changes.tokenSealed !== undefined && { tinvest_token_sealed: changes.tokenSealed }),
          ...(changes.tokenHint !== undefined && { tinvest_token_hint: changes.tokenHint }),
          ...(changes.sandbox !== undefined && { sandbox: changes.sandbox }),
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
      throw nameTaken(error) ?? error
    }
  }
}

function nameTaken(error: unknown): CustomerError | null {
  return isUniqueViolation(error) ? new CustomerError(CustomerErrorCode.NAME_TAKEN, 'customer name is taken') : null
}

function toDomain(row: Selectable<CustomerTable>): Customer {
  return {
    id: row.id,
    name: row.name,
    accountId: row.account_id,
    tokenSealed: row.tinvest_token_sealed,
    tokenHint: row.tinvest_token_hint,
    sandbox: row.sandbox,
    status: row.status,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
