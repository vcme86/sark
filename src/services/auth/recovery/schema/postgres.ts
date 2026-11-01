/**
 * PostgreSQL table schema for MFA recovery code hashes.
 *
 * @module
 */

import { pgTable, text } from 'drizzle-orm/pg-core'

export const recoveryCodeSets = pgTable('recovery_code_sets', {
  sub: text('sub').primaryKey(),
  hashes: text('hashes').notNull(),
  revision: text('revision').notNull(),
})
