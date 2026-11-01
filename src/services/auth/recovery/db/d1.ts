/** Cloudflare D1 authentication persistence; the application owns the borrowed database. */
import { and, eq } from 'drizzle-orm'
import type { DrizzleD1Database } from 'drizzle-orm/d1'

import {
  assertDatabaseDriver,
  type CompatibleTable,
  getDatabase,
  resolveTable,
} from '../../database'
import type { StoreContext, StoreDeclaration } from '../../store'
import { recoveryCodeSets } from '../schema/sqlite'
import type { RecoveryCodeSet, RecoveryStore, SqlRecoveryOptions } from '../types'

export class D1RecoveryStore implements RecoveryStore {
  constructor(
    private readonly db: DrizzleD1Database,
    private readonly codeSets = recoveryCodeSets,
  ) {}

  async read(sub: string): Promise<RecoveryCodeSet | null> {
    const [row] = await this.db.select().from(this.codeSets).where(eq(this.codeSets.sub, sub))
    if (!row) return null
    return { revision: row.revision, hashes: JSON.parse(row.hashes) }
  }

  async commit(
    sub: string,
    expectedRevision: string | null,
    next: RecoveryCodeSet | null,
  ): Promise<boolean> {
    if (expectedRevision === null) {
      if (!next) return false
      const rows = await this.db
        .insert(this.codeSets)
        .values({ sub, revision: next.revision, hashes: JSON.stringify(next.hashes) })
        .onConflictDoNothing({ target: this.codeSets.sub })
        .returning({ revision: this.codeSets.revision })
      return rows.length > 0
    }
    const condition = and(eq(this.codeSets.sub, sub), eq(this.codeSets.revision, expectedRevision))
    const rows =
      next === null
        ? await this.db
            .delete(this.codeSets)
            .where(condition)
            .returning({ revision: this.codeSets.revision })
        : await this.db
            .update(this.codeSets)
            .set({ sub, revision: next.revision, hashes: JSON.stringify(next.hashes) })
            .where(condition)
            .returning({ revision: this.codeSets.revision })
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
  options: SqlRecoveryOptions<CompatibleTable<typeof recoveryCodeSets>>,
): StoreDeclaration<RecoveryStore> {
  assertDatabaseDriver(options.database, 'd1')
  const codeSets = resolveTable(options.tables?.codeSets, recoveryCodeSets)
  return {
    target: 'cloudflare',
    create(context: StoreContext) {
      return {
        value: new D1RecoveryStore(
          getDatabase<DrizzleD1Database>(options.database, context),
          codeSets,
        ),
      }
    },
  }
}
