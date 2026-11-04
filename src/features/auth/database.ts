/** Database association and compatible table mappings used by authentication adapters. */
import { type AnyColumn, getTableColumns, type Table } from 'drizzle-orm'
import type { PgTable } from 'drizzle-orm/pg-core'
import type { SQLiteTable } from 'drizzle-orm/sqlite-core'

import type { ResourceAssembly } from '../../app/resource'
import type { StoreContext } from './store'

/** Keeps logical fields and column semantics while allowing physical names to change. */
export type CompatibleTable<T extends Table> = (T extends PgTable ? PgTable : SQLiteTable) & {
  [K in keyof T['_']['columns']]: AnyColumn<
    Pick<T['_']['columns'][K]['_'], 'data' | 'notNull' | 'dataType'>
  >
}

/** Validates mappings once; query code retains the default table's column inference. */
export function resolveTable<T extends Table>(
  table: CompatibleTable<T> | undefined,
  standard: T,
): T {
  if (!table) return standard
  const supplied = getTableColumns(table)
  for (const [field, column] of Object.entries(getTableColumns(standard))) {
    const mapped = supplied[field]
    if (!mapped || mapped.dataType !== column.dataType || mapped.notNull !== column.notNull)
      throw new Error(`Incompatible authentication column mapping: ${field}.`)
  }
  // The checked mapping differs in physical identifiers, which Drizzle's nominal table type retains.
  return table as unknown as T
}

/** Rejects mismatched official drivers while declarations are being assembled. */
export function assertDatabaseDriver(declaration: ResourceAssembly, driver: string): void {
  if (!('driver' in declaration) || declaration.driver !== driver)
    throw new Error(`Authentication adapter requires a ${driver} database declaration.`)
}

/** Resolves exactly the database declaration supplied to an adapter, without opening a connection. */
export function getDatabase<T>(declaration: ResourceAssembly, context: StoreContext): T {
  const name = Object.keys(context.resourceDeclarations).find(
    (key) => context.resourceDeclarations[key] === declaration,
  )
  if (!name)
    throw new Error('Authentication store database must be an application resource declaration.')
  return context.resources[name] as T
}
