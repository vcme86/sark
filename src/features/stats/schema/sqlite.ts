/**
 * SQLite / D1 table schemas for business counters and unique subjects.
 *
 * @module
 */

import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/** Default SQLite table schema for business counters. */
export const statsCounters = sqliteTable(
  'stats_counters',
  {
    name: text('name').notNull(),
    key: text('key').notNull(),
    period: text('period').notNull(),
    count: integer('count').notNull(),
  },
  (table) => [primaryKey({ columns: [table.name, table.key, table.period] })],
)

/** Default SQLite table schema for deduplication subject markers. */
export const statsSubjects = sqliteTable(
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
