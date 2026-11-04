/** SQLite persistence over the application's borrowed better-sqlite3 resource. */
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'

import type { ResourceAssembly } from '../../../app/resource'
import { assertDatabaseDriver, getDatabase } from '../../db/store'
import { statsCounters, statsSubjects } from '../schema/sqlite'
import { requireStatsSubjects, resolveStatsTables, type StatsTables } from '../tables'
import type { StatsScope, StatsStore, StatsStoreDeclaration, StatsSubject } from '../types'
import { counterUpsert, countsQuery, subjectInsert } from './sql'

export type SqliteStatsTables = StatsTables<typeof statsCounters, typeof statsSubjects>

export interface SqliteStatsOptions {
  /** Database resource declaration owned by the application. */
  readonly database: ResourceAssembly
  /** Complete custom mapping group; omitted to use the default tables. */
  readonly tables?: SqliteStatsTables
}

/**
 * Declares SQLite persistence without opening a connection or running migrations.
 *
 * @param options - Borrowed database declaration and optional complete table group.
 * @returns Store declaration; unique counters require a subjects mapping at creation.
 * @throws If the driver or table mappings are incompatible.
 */
export function sqlStats(options: SqliteStatsOptions): StatsStoreDeclaration {
  assertDatabaseDriver(options.database, 'sqlite')
  const tables = resolveStatsTables(options.tables, statsCounters, statsSubjects)
  return {
    target: 'node',
    create(context) {
      requireStatsSubjects(context.requirements.unique, tables.subjects)
      return {
        value: new SqliteStatsStore(
          getDatabase<BetterSQLite3Database>(options.database, context),
          tables.counters,
          context.requirements.unique ? tables.subjects : undefined,
        ),
      }
    },
  }
}

/** Synchronous transactions keep the counter and optional subject marker atomic. */
export class SqliteStatsStore implements StatsStore {
  constructor(
    private readonly db: BetterSQLite3Database,
    private readonly counters: typeof statsCounters,
    private readonly subjects?: typeof statsSubjects,
  ) {}

  async record(input: StatsScope & { subject?: StatsSubject }): Promise<void> {
    if (!input.subject) {
      counterUpsert(this.db, this.counters, input).run()
      return
    }
    this.db.transaction((tx) => {
      counterUpsert(tx, this.counters, input).run()
      subjectInsert(tx, this.subjects!, input, input.subject!).run()
    })
  }

  async read(input: StatsScope & { unique: boolean }) {
    const row = countsQuery(this.db, this.counters, this.subjects, input).get()
    return row ?? (input.unique ? { count: 0, uniqueCount: 0 } : { count: 0 })
  }
}
