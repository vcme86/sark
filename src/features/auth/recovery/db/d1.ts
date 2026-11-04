/** Cloudflare D1 authentication persistence; the application owns the borrowed database. */
import type { DrizzleD1Database } from 'drizzle-orm/d1'

import {
  assertDatabaseDriver,
  type CompatibleTable,
  getDatabase,
  resolveTable,
} from '../../database'
import type { StoreContext, StoreDeclaration } from '../../store'
import { recoveryCodeSets } from '../schema/sqlite'
import type { RecoveryStore, SqlRecoveryOptions } from '../types'
import { SqlRecoveryStore } from './sql'

/**
 * Declares persistence using a database owned by the application.
 * @param options - Database declaration and optional compatible table mappings.
 * @returns A store declaration initialized after application resources are ready.
 * @throws If the database driver or mapped columns are incompatible.
 */
export function sqlRecovery(
  options: SqlRecoveryOptions<CompatibleTable<typeof recoveryCodeSets>>,
): StoreDeclaration<RecoveryStore> {
  assertDatabaseDriver(options.database, 'd1')
  const codeSets = resolveTable(options.tables?.codeSets, recoveryCodeSets)
  return {
    target: 'cloudflare',
    create(context: StoreContext) {
      return {
        value: new SqlRecoveryStore(
          getDatabase<DrizzleD1Database>(options.database, context),
          codeSets,
        ),
      }
    },
  }
}
