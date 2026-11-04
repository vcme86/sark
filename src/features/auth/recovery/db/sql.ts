/** Shared SQLite/D1 domain operations over Drizzle's synchronous and asynchronous SQLite API. */
import { and, eq } from 'drizzle-orm'
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core'

import { recoveryCodeSets } from '../schema/sqlite'
import type { RecoveryCodeSet, RecoveryStore } from '../types'

export class SqlRecoveryStore implements RecoveryStore {
  constructor(
    private readonly db: BaseSQLiteDatabase<'sync' | 'async', unknown>,
    private readonly codeSets = recoveryCodeSets,
  ) {}

  async read(sub: string): Promise<RecoveryCodeSet | null> {
    const [row] = await this.db.select().from(this.codeSets).where(eq(this.codeSets.sub, sub)).all()
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
        .all()
      return rows.length > 0
    }
    const condition = and(eq(this.codeSets.sub, sub), eq(this.codeSets.revision, expectedRevision))
    const rows =
      next === null
        ? await this.db
            .delete(this.codeSets)
            .where(condition)
            .returning({ revision: this.codeSets.revision })
            .all()
        : await this.db
            .update(this.codeSets)
            .set({ sub, revision: next.revision, hashes: JSON.stringify(next.hashes) })
            .where(condition)
            .returning({ revision: this.codeSets.revision })
            .all()
    return rows.length > 0
  }
}
