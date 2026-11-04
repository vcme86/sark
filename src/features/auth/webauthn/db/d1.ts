/** Cloudflare D1 authentication persistence; the application owns the borrowed database. */
import type { DrizzleD1Database } from 'drizzle-orm/d1'

import type { StoreContext, StoreDeclaration } from '../../../../app/store'
import {
  assertDatabaseDriver,
  type CompatibleTable,
  getDatabase,
  resolveTable,
} from '../../../db/store'
import { webauthnCredentials, webauthnSubjects } from '../schema/sqlite'
import type { SqlWebAuthnOptions, WebAuthnStore } from '../store'
import { SqlWebAuthnStore } from './sql'

/**
 * Declares persistence using a database owned by the application.
 *
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
  assertDatabaseDriver(options.database, 'd1')
  const subjects = resolveTable(options.tables?.subjects, webauthnSubjects)
  const credentials = resolveTable(options.tables?.credentials, webauthnCredentials)
  return {
    target: 'cloudflare',
    create(context: StoreContext) {
      return {
        value: new SqlWebAuthnStore(
          getDatabase<DrizzleD1Database>(options.database, context),
          subjects,
          credentials,
        ),
      }
    },
  }
}
