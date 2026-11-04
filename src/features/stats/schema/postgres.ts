/**
 * PostgreSQL table schemas for business counters and unique subjects.
 *
 * @module
 */

import { integer, pgTable, primaryKey, text } from 'drizzle-orm/pg-core'

/** Default PostgreSQL table schema for business counters. */
export const statsCounters = pgTable(
  'stats_counters',
  {
    name: text('name').notNull(),
    key: text('key').notNull(),
    period: text('period').notNull(),
    count: integer('count').notNull(),
  },
  (table) => [primaryKey({ columns: [table.name, table.key, table.period] })],
)

/** Default PostgreSQL table schema for deduplication subject markers. */
export const statsSubjects = pgTable(
  'stats_subjects',
  {
    name: text('name').notNull(),
    key: text('key').notNull(),
    period: text('period').notNull(),
    kind: text('kind').notNull(),
    id: text('id').notNull(),
  },
  (table) => [primaryKey({ columns: [table.name, table.key, table.period, table.kind, table.id] })],
)
