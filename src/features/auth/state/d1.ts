/** Cloudflare D1 challenge transitions and account attempt counters are committed together. */
import { and, eq, exists, gt, inArray, lt, sql } from 'drizzle-orm'
import type { DrizzleD1Database } from 'drizzle-orm/d1'

import { assertDatabaseDriver, type CompatibleTable, getDatabase, resolveTable } from '../database'
import type { StoreContext, StoreDeclaration } from '../store'
import { authAttemptWindows, authChallenges } from './schema/d1'
import { createCleanupGate, decodeFlow, encodeFlowData } from './sql'
import type {
  AuthAttemptLimit,
  AuthFlow,
  AuthStateStore,
  ClaimResult,
  SqlAuthStateOptions,
} from './types'

export class D1AuthStateStore implements AuthStateStore {
  constructor(
    private readonly db: DrizzleD1Database,
    private readonly challenges = authChallenges,
    private readonly attemptWindows = authAttemptWindows,
    private readonly cleanup: (now: number) => void = () => {},
  ) {}

  async create(flow: AuthFlow): Promise<boolean> {
    this.cleanup(Date.now())
    const rows = await this.db
      .insert(this.challenges)
      .values({
        id: flow.id,
        revision: flow.revision,
        purpose: flow.purpose,
        createdAt: flow.createdAt,
        expiresAt: flow.expiresAt,
        attempts: flow.attempts,
        maxAttempts: flow.maxAttempts,
        status: flow.status,
        sub: flow.sub ?? null,
        claimId: flow.claimId ?? null,
        data: encodeFlowData(flow),
      })
      .onConflictDoNothing({ target: this.challenges.id })
      .returning({ id: this.challenges.id })
    return rows.length > 0
  }

  async read(id: string): Promise<AuthFlow | null> {
    const [row] = await this.db
      .select()
      .from(this.challenges)
      .where(and(eq(this.challenges.id, id), gt(this.challenges.expiresAt, Date.now())))
    return row ? decodeFlow(row) : null
  }

  async bindProtocol(
    id: string,
    revision: string,
    protocol: Record<string, unknown>,
    now: number,
  ): Promise<AuthFlow | null> {
    const current = await this.read(id)
    if (!current || current.status !== 'pending' || current.expiresAt <= now) return null
    if (current.protocol !== undefined) return current
    if (current.revision !== revision) return null
    const [updated] = await this.db
      .update(this.challenges)
      .set({
        revision: crypto.randomUUID(),
        data: encodeFlowData({ data: current.data, protocol }),
      })
      .where(
        and(
          eq(this.challenges.id, id),
          eq(this.challenges.revision, revision),
          eq(this.challenges.status, 'pending'),
          gt(this.challenges.expiresAt, now),
        ),
      )
      .returning()
    if (updated) return decodeFlow(updated)
    const winner = await this.read(id)
    return winner?.status === 'pending' && winner.protocol !== undefined ? winner : null
  }

  async claim(
    id: string,
    claimId: string,
    now: number,
    account?: AuthAttemptLimit,
  ): Promise<ClaimResult> {
    this.cleanup(now)
    const revision = crypto.randomUUID()
    const key = account ? JSON.stringify([account.sub, account.purpose]) : undefined
    const limited = account
      ? exists(
          this.db
            .select({ value: sql`1` })
            .from(this.attemptWindows)
            .where(
              and(
                eq(this.attemptWindows.windowKey, key!),
                gt(this.attemptWindows.expiresAt, now),
                sql`${this.attemptWindows.count} >= ${account.maxAttempts}`,
              ),
            ),
        )
      : sql`0`
    const claim = this.db
      .update(this.challenges)
      .set({
        status: 'verifying',
        claimId,
        revision,
        attempts: sql`${this.challenges.attempts} + 1`,
      })
      .where(
        and(
          eq(this.challenges.id, id),
          eq(this.challenges.status, 'pending'),
          gt(this.challenges.expiresAt, now),
          sql`${this.challenges.attempts} < ${this.challenges.maxAttempts}`,
          sql`NOT ${limited}`,
        ),
      )
      .returning()
    if (!account) {
      const [row] = await claim
      return row ? { status: 'claimed', flow: decodeFlow(row) } : { status: 'invalid' }
    }
    // Zero-row claims must not spend account budget. The INSERT selects only this batch's claimed row.
    const spend = this.db
      .insert(this.attemptWindows)
      .select(
        this.db
          .select({
            windowKey: sql<string>`${key}`.as('window_key'),
            count: sql<number>`1`.as('count'),
            expiresAt: sql<number>`${now + account.window}`.as('expires_at'),
          })
          .from(this.challenges)
          .where(
            and(
              eq(this.challenges.id, id),
              eq(this.challenges.claimId, claimId),
              eq(this.challenges.revision, revision),
              eq(this.challenges.status, 'verifying'),
            ),
          ),
      )
      .onConflictDoUpdate({
        target: this.attemptWindows.windowKey,
        set: {
          count: sql`CASE WHEN ${this.attemptWindows.expiresAt} <= ${now} THEN 1 ELSE ${this.attemptWindows.count} + 1 END`,
          expiresAt: sql`CASE WHEN ${this.attemptWindows.expiresAt} <= ${now} THEN ${now + account.window} ELSE ${this.attemptWindows.expiresAt} END`,
        },
      })
    const [rows] = await this.db.batch([claim, spend])
    if (rows.length) return { status: 'claimed', flow: decodeFlow(rows[0]) }
    const flow = await this.read(id)
    if (!flow || flow.status !== 'pending' || flow.attempts >= flow.maxAttempts)
      return { status: 'invalid' }
    return { status: 'limited' }
  }

  async release(id: string, claimId: string, now: number): Promise<boolean> {
    const rows = await this.db
      .update(this.challenges)
      .set({ status: 'pending', claimId: null, revision: crypto.randomUUID() })
      .where(
        and(
          eq(this.challenges.id, id),
          eq(this.challenges.claimId, claimId),
          eq(this.challenges.status, 'verifying'),
          gt(this.challenges.expiresAt, now),
          sql`${this.challenges.attempts} < ${this.challenges.maxAttempts}`,
        ),
      )
      .returning({ id: this.challenges.id })
    return rows.length > 0
  }

  async consume(id: string, claimId: string, now: number): Promise<boolean> {
    const rows = await this.db
      .update(this.challenges)
      .set({ status: 'consumed', claimId: null, revision: crypto.randomUUID() })
      .where(
        and(
          eq(this.challenges.id, id),
          eq(this.challenges.claimId, claimId),
          eq(this.challenges.status, 'verifying'),
          gt(this.challenges.expiresAt, now),
        ),
      )
      .returning({ id: this.challenges.id })
    return rows.length > 0
  }
}

/** Declares shared state using the selected database and compatible physical table mappings. */
export function sqlAuthState(
  options: SqlAuthStateOptions<
    CompatibleTable<typeof authChallenges>,
    CompatibleTable<typeof authAttemptWindows>
  >,
): StoreDeclaration<AuthStateStore> {
  assertDatabaseDriver(options.database, 'd1')
  const challenges = resolveTable(options.tables?.challenges, authChallenges)
  const attemptWindows = resolveTable(options.tables?.attemptWindows, authAttemptWindows)
  const scheduleCleanup = createCleanupGate()
  return {
    target: 'cloudflare',
    create(context: StoreContext) {
      const db = getDatabase<DrizzleD1Database>(options.database, context)
      const cleanup = (now: number) =>
        scheduleCleanup(now, context, async () => {
          const removedChallenges = await db
            .delete(challenges)
            .where(
              inArray(
                challenges.id,
                db
                  .select({ id: challenges.id })
                  .from(challenges)
                  .where(lt(challenges.expiresAt, now))
                  .limit(100),
              ),
            )
            .returning({ id: challenges.id })
          const removedWindows = await db
            .delete(attemptWindows)
            .where(
              inArray(
                attemptWindows.windowKey,
                db
                  .select({ id: attemptWindows.windowKey })
                  .from(attemptWindows)
                  .where(lt(attemptWindows.expiresAt, now))
                  .limit(100),
              ),
            )
            .returning({ id: attemptWindows.windowKey })
          return removedChallenges.length === 100 || removedWindows.length === 100
        })
      return { value: new D1AuthStateStore(db, challenges, attemptWindows, cleanup) }
    },
  }
}
