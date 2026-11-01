/** SQLite authentication persistence; the application owns the borrowed database. */
import { and, eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import {
  assertDatabaseDriver,
  type CompatibleTable,
  getDatabase,
  resolveTable,
} from '../../database'
import type { StoreContext, StoreDeclaration } from '../../store'
import { totpFactors } from '../schema/sqlite'
import type { SqlTotpOptions, TotpRecord, TotpStore } from '../types'

export class SqliteTotpStore implements TotpStore {
  constructor(
    private readonly db: BetterSQLite3Database,
    private readonly factors = totpFactors,
  ) {}

  async read(sub: string): Promise<TotpRecord | null> {
    const [row] = this.db.select().from(this.factors).where(eq(this.factors.sub, sub)).all()
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
      const rows = this.db
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
        ? this.db
            .delete(this.factors)
            .where(condition)
            .returning({ revision: this.factors.revision })
            .all()
        : this.db
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
        value: new SqliteTotpStore(
          getDatabase<BetterSQLite3Database>(options.database, context),
          factors,
        ),
      }
    },
  }
}
