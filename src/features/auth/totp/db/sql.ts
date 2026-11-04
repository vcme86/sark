/** Shared SQLite/D1 domain operations over Drizzle's synchronous and asynchronous SQLite API. */
import { and, eq } from 'drizzle-orm'
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core'

import { totpFactors } from '../schema/sqlite'
import type { TotpRecord, TotpStore } from '../types'

export class SqlTotpStore implements TotpStore {
  constructor(
    private readonly db: BaseSQLiteDatabase<'sync' | 'async', unknown>,
    private readonly factors = totpFactors,
  ) {}

  async read(sub: string): Promise<TotpRecord | null> {
    const [row] = await this.db.select().from(this.factors).where(eq(this.factors.sub, sub)).all()
    if (!row) return null
    return {
      revision: row.revision,
      factorId: row.factorId,
      algorithm: row.algorithm as TotpRecord['algorithm'],
      digits: row.digits,
      period: row.period,
      secret: new Uint8Array(row.secret),
      lastStep: row.lastStep,
      enabledAt: row.enabledAt,
    }
  }

  async commit(
    sub: string,
    expectedRevision: string | null,
    next: TotpRecord | null,
  ): Promise<boolean> {
    if (expectedRevision === null) {
      if (!next) return false
      const rows = await this.db
        .insert(this.factors)
        .values({
          sub,
          revision: next.revision,
          factorId: next.factorId,
          algorithm: next.algorithm,
          digits: next.digits,
          period: next.period,
          secret: Buffer.from(next.secret),
          lastStep: next.lastStep,
          enabledAt: next.enabledAt,
        })
        .onConflictDoNothing({ target: this.factors.sub })
        .returning({ revision: this.factors.revision })
        .all()
      return rows.length > 0
    }
    const condition = and(eq(this.factors.sub, sub), eq(this.factors.revision, expectedRevision))
    const rows =
      next === null
        ? await this.db
            .delete(this.factors)
            .where(condition)
            .returning({ revision: this.factors.revision })
            .all()
        : await this.db
            .update(this.factors)
            .set({
              sub,
              revision: next.revision,
              factorId: next.factorId,
              algorithm: next.algorithm,
              digits: next.digits,
              period: next.period,
              secret: Buffer.from(next.secret),
              lastStep: next.lastStep,
              enabledAt: next.enabledAt,
            })
            .where(condition)
            .returning({ revision: this.factors.revision })
            .all()
    return rows.length > 0
  }
}
