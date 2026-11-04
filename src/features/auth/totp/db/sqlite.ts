/** SQLite authentication persistence; the application owns the borrowed database. */
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import {
  assertDatabaseDriver,
  type CompatibleTable,
  getDatabase,
  resolveTable,
} from '../../database'
import type { StoreContext, StoreDeclaration } from '../../store'
import { totpFactors } from '../schema/sqlite'
import type { SqlTotpOptions, TotpStore } from '../types'
import { SqlTotpStore } from './sql'

/**
 * Declares persistence using a database owned by the application.
 * @param options - Database declaration and optional compatible table mappings.
 * @returns A store declaration initialized after application resources are ready.
 * @throws If the database driver or mapped columns are incompatible.
 */
export function sqlTotp(
  options: SqlTotpOptions<CompatibleTable<typeof totpFactors>>,
): StoreDeclaration<TotpStore> {
  assertDatabaseDriver(options.database, 'sqlite')
  const factors = resolveTable(options.tables?.factors, totpFactors)
  return {
    target: 'node',
    create(context: StoreContext) {
      return {
        value: new SqlTotpStore(
          getDatabase<BetterSQLite3Database>(options.database, context),
          factors,
        ),
      }
    },
  }
}
