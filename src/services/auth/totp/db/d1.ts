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
import { totpFactors } from '../schema/sqlite'
import type { SqlTotpOptions, TotpRecord, TotpStore } from '../types'

export class D1TotpStore implements TotpStore {
  constructor(
    private readonly db: DrizzleD1Database,
    private readonly factors = totpFactors,
  ) {}

  async read(sub: string): Promise<TotpRecord | null> {
    const [row] = await this.db.select().from(this.factors).where(eq(this.factors.sub, sub))
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
      return rows.length > 0
    }
    const condition = and(eq(this.factors.sub, sub), eq(this.factors.revision, expectedRevision))
    const rows =
      next === null
        ? await this.db
            .delete(this.factors)
            .where(condition)
            .returning({ revision: this.factors.revision })
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
    return rows.length > 0
  }
}

/**
 * Declares persistence using a database owned by the application.
 * @param options - Database declaration and optional compatible table mappings.
 * @returns A store declaration initialized after application resources are ready.
 * @throws If the database driver or mapped columns are incompatible.
 */
export function sqlTotp(
  options: SqlTotpOptions<CompatibleTable<typeof totpFactors>>,
): StoreDeclaration<TotpStore> {
  assertDatabaseDriver(options.database, 'd1')
  const factors = resolveTable(options.tables?.factors, totpFactors)
  return {
    target: 'cloudflare',
    create(context: StoreContext) {
      return {
        value: new D1TotpStore(getDatabase<DrizzleD1Database>(options.database, context), factors),
      }
    },
  }
}
