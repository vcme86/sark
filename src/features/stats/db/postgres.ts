/** PostgreSQL persistence over the application's borrowed postgres.js resource. */
import { and, eq, sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'

import type { ResourceAssembly } from '../../../app/resource'
import { assertDatabaseDriver, getDatabase } from '../../db/store'
import { statsCounters, statsSubjects } from '../schema/postgres'
import { requireStatsSubjects, resolveStatsTables, type StatsTables } from '../tables'
import type { StatsScope, StatsStore, StatsStoreDeclaration, StatsSubject } from '../types'

export type PostgresStatsTables = StatsTables<typeof statsCounters, typeof statsSubjects>

export interface PostgresStatsOptions {
  /** Database resource declaration owned by the application. */
  readonly database: ResourceAssembly
  /** Complete custom mapping group; omitted to use the default tables. */
  readonly tables?: PostgresStatsTables
}

/**
 * Declares PostgreSQL persistence without creating or owning another connection pool.
 *
 * @param options - Borrowed database declaration and optional complete table group.
 * @returns Store declaration; unique counters require a subjects mapping at creation.
 * @throws If the driver or table mappings are incompatible.
 */
export function sqlStats(options: PostgresStatsOptions): StatsStoreDeclaration {
  assertDatabaseDriver(options.database, 'postgres')
  const tables = resolveStatsTables(options.tables, statsCounters, statsSubjects)
  return {
    target: 'node',
    create(context) {
      requireStatsSubjects(context.requirements.unique, tables.subjects)
      return {
        value: new PostgresStatsStore(
          getDatabase<PostgresJsDatabase>(options.database, context),
          tables.counters,
          context.requirements.unique ? tables.subjects : undefined,
        ),
      }
    },
  }
}

/** Owns no pool; only writes containing a subject need a multi-statement transaction. */
export class PostgresStatsStore implements StatsStore {
  constructor(
    private readonly db: PostgresJsDatabase,
    private readonly counters: typeof statsCounters,
    private readonly subjects?: typeof statsSubjects,
  ) {}

  async record(input: StatsScope & { subject?: StatsSubject }): Promise<void> {
    const { counters, subjects } = this
    const upsert = (db: PostgresJsDatabase) =>
      db
        .insert(counters)
        .values({ name: input.name, key: input.key, period: input.period ?? '', count: 1 })
        .onConflictDoUpdate({
          target: [counters.name, counters.key, counters.period],
          set: { count: sql`${counters.count} + 1` },
        })
    if (!input.subject) {
      await upsert(this.db)
      return
    }
    await this.db.transaction(async (tx) => {
      await upsert(tx)
      await tx
        .insert(subjects!)
        .values({ name: input.name, key: input.key, period: input.period ?? '', ...input.subject! })
        .onConflictDoNothing({
          target: [subjects!.name, subjects!.key, subjects!.period, subjects!.kind, subjects!.id],
        })
    })
  }

  async read(input: StatsScope & { unique: boolean }) {
    const { counters, subjects } = this
    const period = input.period ?? ''
    const [row] = await this.db
      .select({
        count: counters.count,
        ...(input.unique
          ? {
              uniqueCount: sql<number>`(
                  SELECT count(*) FROM ${subjects!}
                  WHERE ${subjects!.name} = ${input.name}
                    AND ${subjects!.key} = ${input.key}
                    AND ${subjects!.period} = ${period}
                )`.mapWith(Number),
            }
          : {}),
      })
      .from(counters)
      .where(
        and(
          eq(counters.name, input.name),
          eq(counters.key, input.key),
          eq(counters.period, period),
        ),
      )
    return row ?? (input.unique ? { count: 0, uniqueCount: 0 } : { count: 0 })
  }
}
