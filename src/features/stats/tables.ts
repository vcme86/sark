/** Whole-group table mappings for the official stats adapters. */
import type { Table } from 'drizzle-orm'

import { type CompatibleTable, resolveTable } from '../db/store'
import { StatsError } from './errors'

/** A supplied group owns every mapping; omitted groups use the official defaults. */
export interface StatsTables<Counters extends Table, Subjects extends Table> {
  readonly counters: CompatibleTable<Counters>
  readonly subjects?: CompatibleTable<Subjects>
}

/** Resolves physical mappings once without querying or creating database tables. */
export function resolveStatsTables<Counters extends Table, Subjects extends Table>(
  tables: StatsTables<Counters, Subjects> | undefined,
  counters: Counters,
  subjects: Subjects,
): { counters: Counters; subjects?: Subjects } {
  if (tables === undefined) return { counters, subjects }
  if (!tables || !tables.counters)
    throw new StatsError('stats_config_error', 'Custom stats tables require counters.')
  return {
    counters: resolveTable(tables.counters, counters),
    subjects: tables.subjects === undefined ? undefined : resolveTable(tables.subjects, subjects),
  }
}

/** Checks the configured group against the counters selected by the owning service. */
export function requireStatsSubjects(unique: boolean, subjects: Table | undefined): void {
  if (unique && !subjects)
    throw new StatsError(
      'stats_config_error',
      'Custom stats tables require subjects for unique counters.',
    )
}
