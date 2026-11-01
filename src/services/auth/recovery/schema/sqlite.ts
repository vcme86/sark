/**
 * SQLite table schema for MFA recovery code hashes.
 *
 * @module
 */

import { sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const recovery = sqliteTable('sark_mfa_recovery', {
  sub: text('sub').primaryKey(),
  hashes: text('hashes').notNull(),
  revision: text('revision').notNull(),
})
