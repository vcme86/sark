/**
 * PostgreSQL table schema for encrypted TOTP factors.
 *
 * @module
 */

import { bigint, customType, integer, pgTable, text } from 'drizzle-orm/pg-core'

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea'
  },
})

export const totpFactors = pgTable('totp_factors', {
  sub: text('sub').primaryKey(),
  revision: text('revision').notNull(),
  factorId: text('factor_id').notNull(),
  algorithm: text('algorithm').notNull(),
  digits: integer('digits').notNull(),
  period: integer('period').notNull(),
  secret: bytea('secret').notNull(),
  lastStep: bigint('last_step', { mode: 'number' }).notNull(),
  enabledAt: bigint('enabled_at', { mode: 'number' }).notNull(),
})
