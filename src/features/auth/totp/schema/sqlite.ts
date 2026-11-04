/**
 * SQLite table schema for encrypted TOTP factors.
 *
 * @module
 */

import { blob, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const totpFactors = sqliteTable('totp_factors', {
  sub: text('sub').primaryKey(),
  revision: text('revision').notNull(),
  factorId: text('factor_id').notNull(),
  algorithm: text('algorithm').notNull(),
  digits: integer('digits').notNull(),
  period: integer('period').notNull(),
  secret: blob('secret', { mode: 'buffer' }).notNull(),
  lastStep: integer('last_step').notNull(),
  enabledAt: integer('enabled_at').notNull(),
})
