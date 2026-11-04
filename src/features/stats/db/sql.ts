/** Shared SQLite/D1 query construction; callers own synchronous transactions or D1 batches. */
import { and, eq, sql } from 'drizzle-orm'
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core'

import type { statsCounters, statsSubjects } from '../schema/sqlite'
import type { StatsScope, StatsSubject } from '../types'

export function counterUpsert<Kind extends 'sync' | 'async', Result>(
  db: BaseSQLiteDatabase<Kind, Result>,
  counters: typeof statsCounters,
  scope: StatsScope,
) {
  return db
    .insert(counters)
    .values({ name: scope.name, key: scope.key, period: scope.period ?? '', count: 1 })
    .onConflictDoUpdate({
      target: [counters.name, counters.key, counters.period],
      set: { count: sql`${counters.count} + 1` },
    })
}

export function subjectInsert<Kind extends 'sync' | 'async', Result>(
  db: BaseSQLiteDatabase<Kind, Result>,
  subjects: typeof statsSubjects,
  scope: StatsScope,
  subject: StatsSubject,
) {
  return db
    .insert(subjects)
    .values({ name: scope.name, key: scope.key, period: scope.period ?? '', ...subject })
    .onConflictDoNothing({
      target: [subjects.name, subjects.key, subjects.period, subjects.kind, subjects.id],
    })
}

/** One SELECT gives both values the same snapshot, including while writers are active. */
export function countsQuery<Kind extends 'sync' | 'async', Result>(
  db: BaseSQLiteDatabase<Kind, Result>,
  counters: typeof statsCounters,
  subjects: typeof statsSubjects | undefined,
  scope: StatsScope & { unique: boolean },
) {
  const period = scope.period ?? ''
  const fields = {
    count: counters.count,
    ...(scope.unique
      ? {
          uniqueCount: sql<number>`(
              SELECT count(*) FROM ${subjects!}
              WHERE ${subjects!.name} = ${scope.name}
                AND ${subjects!.key} = ${scope.key}
                AND ${subjects!.period} = ${period}
            )`.mapWith(Number),
        }
      : {}),
  }
  return db
    .select(fields)
    .from(counters)
    .where(
      and(eq(counters.name, scope.name), eq(counters.key, scope.key), eq(counters.period, period)),
    )
}
