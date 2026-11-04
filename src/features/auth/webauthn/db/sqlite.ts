/** SQLite authentication persistence; the application owns the borrowed database. */
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import {
  assertDatabaseDriver,
  type CompatibleTable,
  getDatabase,
  resolveTable,
} from '../../database'
import type { StoreContext, StoreDeclaration } from '../../store'
import { webauthnCredentials, webauthnSubjects } from '../schema/sqlite'
import type { SqlWebAuthnOptions, WebAuthnStore } from '../store'
import { SqlWebAuthnStore } from './sql'

/**
 * Declares persistence using a database owned by the application.
 * @param options - Database declaration and optional compatible table mappings.
 * @returns A store declaration initialized after application resources are ready.
 * @throws If the database driver or mapped columns are incompatible.
 */
export function sqlWebAuthn(
  options: SqlWebAuthnOptions<
    CompatibleTable<typeof webauthnSubjects>,
    CompatibleTable<typeof webauthnCredentials>
  >,
): StoreDeclaration<WebAuthnStore> {
  assertDatabaseDriver(options.database, 'sqlite')
  const subjects = resolveTable(options.tables?.subjects, webauthnSubjects)
  const credentials = resolveTable(options.tables?.credentials, webauthnCredentials)
  return {
    target: 'node',
    create(context: StoreContext) {
      return {
        value: new SqlWebAuthnStore(
          getDatabase<BetterSQLite3Database>(options.database, context),
          subjects,
          credentials,
        ),
      }
    },
  }
}
