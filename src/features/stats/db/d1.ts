/** D1 persistence using the current Workers event's borrowed database. */
import type { DrizzleD1Database } from 'drizzle-orm/d1'

import type { ResourceAssembly } from '../../../app/resource'
import { assertDatabaseDriver, getDatabase } from '../../db/store'
import { statsCounters, statsSubjects } from '../schema/sqlite'
import { requireStatsSubjects, resolveStatsTables, type StatsTables } from '../tables'
import type { StatsScope, StatsStore, StatsStoreDeclaration, StatsSubject } from '../types'
import { counterUpsert, countsQuery, subjectInsert } from './sql'

export type D1StatsTables = StatsTables<typeof statsCounters, typeof statsSubjects>

export interface D1StatsOptions {
  /** Database resource declaration owned by the application. */
  readonly database: ResourceAssembly
  /** Complete custom mapping group; omitted to use the default tables. */
  readonly tables?: D1StatsTables
}

/**
 * Declares D1 persistence without accessing a binding or running migrations.
 *
 * @param options - Borrowed database declaration and optional complete table group.
 * @returns Store declaration bound to the current event; unique counters require subjects.
 * @throws If the driver or table mappings are incompatible.
 */
export function sqlStats(options: D1StatsOptions): StatsStoreDeclaration {
  assertDatabaseDriver(options.database, 'd1')
  const tables = resolveStatsTables(options.tables, statsCounters, statsSubjects)
  return {
    target: 'cloudflare',
    create(context) {
      requireStatsSubjects(context.requirements.unique, tables.subjects)
      return {
        value: new D1StatsStore(
          getDatabase<DrizzleD1Database>(options.database, context),
          tables.counters,
          context.requirements.unique ? tables.subjects : undefined,
        ),
      }
    },
  }
}

/** D1 batches roll back both statements on SQL failure; duplicate subjects are normal conflicts. */
export class D1StatsStore implements StatsStore {
  constructor(
    private readonly db: DrizzleD1Database,
    private readonly counters: typeof statsCounters,
    private readonly subjects?: typeof statsSubjects,
  ) {}

  async record(input: StatsScope & { subject?: StatsSubject }): Promise<void> {
    const counter = counterUpsert(this.db, this.counters, input)
    if (input.subject)
      await this.db.batch([counter, subjectInsert(this.db, this.subjects!, input, input.subject)])
    else await counter.run()
  }

  async read(input: StatsScope & { unique: boolean }) {
    const row = await countsQuery(this.db, this.counters, this.subjects, input).get()
    return row ?? (input.unique ? { count: 0, uniqueCount: 0 } : { count: 0 })
  }
}
