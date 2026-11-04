/**
 * SQLite table schema for MFA recovery code hashes.
 *
 * @module
 */

import { sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const recoveryCodeSets = sqliteTable('recovery_code_sets', {
  sub: text('sub').primaryKey(),
  hashes: text('hashes').notNull(),
  revision: text('revision').notNull(),
})
