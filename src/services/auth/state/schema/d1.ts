/**
 * Cloudflare D1 table schemas for MFA ephemeral challenges and account throttling.
 *
 * @module
 */

import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const challenges = sqliteTable(
  'sark_mfa_challenges',
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
  (table) => [index('sark_mfa_challenges_expires_at_idx').on(table.expiresAt)],
)

export const attempts = sqliteTable(
  'sark_mfa_attempts',
  {
    accountId: text('account_id').primaryKey(),
    count: integer('count').notNull(),
    expiresAt: integer('expires_at').notNull(),
  },
  (table) => [index('sark_mfa_attempts_expires_at_idx').on(table.expiresAt)],
)
