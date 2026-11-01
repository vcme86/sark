/**
 * PostgreSQL table schemas for MFA ephemeral challenges and account throttling.
 *
 * @module
 */

import { bigint, index, integer, pgTable, text } from 'drizzle-orm/pg-core'

export const authChallenges = pgTable(
  'auth_challenges',
  {
    id: text('id').primaryKey(),
    revision: text('revision').notNull(),
    purpose: text('purpose').notNull(),
    sub: text('sub'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
    attempts: integer('attempts').notNull(),
    maxAttempts: integer('max_attempts').notNull(),
    status: text('status').notNull(),
    claimId: text('claim_id'),
    data: text('data').notNull(),
  },
  (table) => [index('auth_challenges_expires_at_idx').on(table.expiresAt)],
)

export const authAttemptWindows = pgTable(
  'auth_attempt_windows',
  {
    windowKey: text('window_key').primaryKey(),
    count: integer('count').notNull(),
    expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
  },
  (table) => [index('auth_attempt_windows_expires_at_idx').on(table.expiresAt)],
)
