/** PostgreSQL challenge transitions and account budgets are committed together. */
import { and, eq, gt, inArray, lt, or, sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

import { assertDatabaseDriver, type CompatibleTable, getDatabase, resolveTable } from '../database'
import type { StoreContext, StoreDeclaration } from '../store'
import { attempts, challenges } from './schema/postgres'
import { createCleanupGate, decodeFlow, encodeFlowData } from './sql'
import type {
  AccountLimitParams,
  AuthFlow,
  AuthStateStore,
  ClaimResult,
  SqlAuthStateOptions,
} from './types'

export class PostgresAuthStateStore implements AuthStateStore {
  constructor(
    private readonly db: PostgresJsDatabase,
    private readonly flows = challenges,
    private readonly budgets = attempts,
    private readonly cleanup: (now: number) => void = () => {},
  ) {}

  async create(flow: AuthFlow): Promise<boolean> {
    this.cleanup(Date.now())
    const rows = await this.db
      .insert(this.flows)
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
      .onConflictDoNothing({ target: this.flows.id })
      .returning({ id: this.flows.id })
    return rows.length > 0
  }

  async read(id: string): Promise<AuthFlow | null> {
    const [row] = await this.db
      .select()
      .from(this.flows)
      .where(and(eq(this.flows.id, id), gt(this.flows.expiresAt, Date.now())))
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
      .update(this.flows)
      .set({
        revision: crypto.randomUUID(),
        data: encodeFlowData({ data: current.data, protocol }),
      })
      .where(
        and(
          eq(this.flows.id, id),
          eq(this.flows.revision, revision),
          eq(this.flows.status, 'pending'),
          gt(this.flows.expiresAt, now),
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
    account?: AccountLimitParams,
  ): Promise<ClaimResult> {
    this.cleanup(now)
    return this.db.transaction(async (tx) => {
      const [flow] = await tx.select().from(this.flows).where(eq(this.flows.id, id)).for('update')
      if (
        !flow ||
        flow.status !== 'pending' ||
        flow.expiresAt <= now ||
        flow.attempts >= flow.maxAttempts
      )
        return { status: 'invalid' }
      if (account) {
        const key = JSON.stringify([account.sub, account.purpose])
        const [budget] = await tx
          .insert(this.budgets)
          .values({ accountId: key, count: 1, expiresAt: now + account.window })
          .onConflictDoUpdate({
            target: this.budgets.accountId,
            set: {
              count: sql`CASE WHEN ${this.budgets.expiresAt} <= ${now} THEN 1 ELSE ${this.budgets.count} + 1 END`,
              expiresAt: sql`CASE WHEN ${this.budgets.expiresAt} <= ${now} THEN ${now + account.window} ELSE ${this.budgets.expiresAt} END`,
            },
            setWhere: or(
              lt(this.budgets.count, account.maxAttempts),
              sql`${this.budgets.expiresAt} <= ${now}`,
            ),
          })
          .returning({ count: this.budgets.count })
        if (!budget) return { status: 'limited' }
      }
      const [claimed] = await tx
        .update(this.flows)
        .set({
          status: 'verifying',
          claimId,
          revision: crypto.randomUUID(),
          attempts: flow.attempts + 1,
        })
        .where(eq(this.flows.id, id))
        .returning()
      return { status: 'claimed', flow: decodeFlow(claimed) }
    })
  }

  async release(id: string, claimId: string, now: number): Promise<boolean> {
    const rows = await this.db
      .update(this.flows)
      .set({ status: 'pending', claimId: null, revision: crypto.randomUUID() })
      .where(
        and(
          eq(this.flows.id, id),
          eq(this.flows.claimId, claimId),
          eq(this.flows.status, 'verifying'),
          gt(this.flows.expiresAt, now),
          sql`${this.flows.attempts} < ${this.flows.maxAttempts}`,
        ),
      )
      .returning({ id: this.flows.id })
    return rows.length > 0
  }

  async consume(id: string, claimId: string, now: number): Promise<boolean> {
    const rows = await this.db
      .update(this.flows)
      .set({ status: 'consumed', claimId: null, revision: crypto.randomUUID() })
      .where(
        and(
          eq(this.flows.id, id),
          eq(this.flows.claimId, claimId),
          eq(this.flows.status, 'verifying'),
          gt(this.flows.expiresAt, now),
        ),
      )
      .returning({ id: this.flows.id })
    return rows.length > 0
  }
}

/** Declares shared state using the selected database and compatible physical table mappings. */
export function sqlAuthState(
  options: SqlAuthStateOptions<
    CompatibleTable<typeof challenges>,
    CompatibleTable<typeof attempts>
  >,
): StoreDeclaration<AuthStateStore> {
  assertDatabaseDriver(options.database, 'postgres')
  const flows = resolveTable(options.tables?.challenges, challenges)
  const budgets = resolveTable(options.tables?.attempts, attempts)
  const scheduleCleanup = createCleanupGate()
  return {
    target: 'node',
    create(context: StoreContext) {
      const db = getDatabase<PostgresJsDatabase>(options.database, context)
      const cleanup = (now: number) =>
        scheduleCleanup(now, context, async () => {
          const removedFlows = await db
            .delete(flows)
            .where(
              inArray(
                flows.id,
                db.select({ id: flows.id }).from(flows).where(lt(flows.expiresAt, now)).limit(100),
              ),
            )
            .returning({ id: flows.id })
          const removedBudgets = await db
            .delete(budgets)
            .where(
              inArray(
                budgets.accountId,
                db
                  .select({ id: budgets.accountId })
                  .from(budgets)
                  .where(lt(budgets.expiresAt, now))
                  .limit(100),
              ),
            )
            .returning({ id: budgets.accountId })
          return removedFlows.length === 100 || removedBudgets.length === 100
        })
      return { value: new PostgresAuthStateStore(db, flows, budgets, cleanup) }
    },
  }
}
