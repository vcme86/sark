/**
 * Cloudflare D1 table schemas for MFA ephemeral challenges and account throttling.
 *
 * @module
 */

import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const authChallenges = sqliteTable(
  'auth_challenges',
  {
    id: text('id').primaryKey(),
    revision: text('revision').notNull(),
    purpose: text('purpose').notNull(),
    sub: text('sub'),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    attempts: integer('attempts').notNull(),
    maxAttempts: integer('max_attempts').notNull(),
    status: text('status').notNull(),
    claimId: text('claim_id'),
    data: text('data').notNull(),
  },
  (table) => [index('auth_challenges_expires_at_idx').on(table.expiresAt)],
)

export const authAttemptWindows = sqliteTable(
  'auth_attempt_windows',
  {
    windowKey: text('window_key').primaryKey(),
    count: integer('count').notNull(),
    expiresAt: integer('expires_at').notNull(),
  },
  (table) => [index('auth_attempt_windows_expires_at_idx').on(table.expiresAt)],
)
