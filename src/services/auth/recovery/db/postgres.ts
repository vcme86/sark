/** PostgreSQL authentication persistence; the application owns the borrowed database. */
import { and, eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

import {
  assertDatabaseDriver,
  type CompatibleTable,
  getDatabase,
  resolveTable,
} from '../../database'
import type { StoreContext, StoreDeclaration } from '../../store'
import { recovery as recoveryTable } from '../schema/postgres'
import type { RecoveryRecord, RecoveryStore, SqlRecoveryOptions } from '../types'

export class PostgresRecoveryStore implements RecoveryStore {
  constructor(
    private readonly db: PostgresJsDatabase,
    private readonly recovery = recoveryTable,
  ) {}

  async read(sub: string): Promise<RecoveryRecord | null> {
    const [row] = await this.db.select().from(this.recovery).where(eq(this.recovery.sub, sub))
    if (!row) return null
    return { revision: row.revision, hashes: JSON.parse(row.hashes) }
  }

  async commit(
    sub: string,
    expectedRevision: string | null,
    next: RecoveryRecord | null,
  ): Promise<boolean> {
    if (expectedRevision === null) {
      if (!next) return false
      const rows = await this.db
        .insert(this.recovery)
        .values({ sub, revision: next.revision, hashes: JSON.stringify(next.hashes) })
        .onConflictDoNothing({ target: this.recovery.sub })
        .returning({ revision: this.recovery.revision })
      return rows.length > 0
    }
    const condition = and(eq(this.recovery.sub, sub), eq(this.recovery.revision, expectedRevision))
    const rows =
      next === null
        ? await this.db
            .delete(this.recovery)
            .where(condition)
            .returning({ revision: this.recovery.revision })
        : await this.db
            .update(this.recovery)
            .set({ sub, revision: next.revision, hashes: JSON.stringify(next.hashes) })
            .where(condition)
            .returning({ revision: this.recovery.revision })
    return rows.length > 0
  }
}

/**
 * Declares persistence using a database owned by the application.
 * @param options - Database declaration and optional compatible table mappings.
 * @returns A store declaration initialized after application resources are ready.
 * @throws If the database driver or mapped columns are incompatible.
 */
export function sqlRecovery(
  options: SqlRecoveryOptions<CompatibleTable<typeof recoveryTable>>,
): StoreDeclaration<RecoveryStore> {
  assertDatabaseDriver(options.database, 'postgres')
  const recovery = resolveTable(options.tables?.recovery, recoveryTable)
  return {
    target: 'node',
    create(context: StoreContext) {
      return {
        value: new PostgresRecoveryStore(
          getDatabase<PostgresJsDatabase>(options.database, context),
          recovery,
        ),
      }
    },
  }
}
