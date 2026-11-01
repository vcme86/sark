/**
 * PostgreSQL table schema for MFA recovery code hashes.
 *
 * @module
 */

import { pgTable, text } from 'drizzle-orm/pg-core'

export const recovery = pgTable('sark_mfa_recovery', {
  sub: text('sub').primaryKey(),
  hashes: text('hashes').notNull(),
  revision: text('revision').notNull(),
})
