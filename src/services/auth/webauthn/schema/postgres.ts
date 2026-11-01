/**
 * PostgreSQL table schemas for WebAuthn subjects and registered credentials.
 *
 * @module
 */

import { bigint, boolean, customType, index, pgTable, text } from 'drizzle-orm/pg-core'

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea'
  },
})

export const subjects = pgTable('sark_webauthn_subjects', {
  sub: text('sub').primaryKey(),
  userHandle: text('user_handle').notNull().unique(),
})

export const credentials = pgTable(
  'sark_webauthn_credentials',
  {
    credentialId: text('credential_id').primaryKey(),
    sub: text('sub').notNull(),
    userHandle: text('user_handle').notNull(),
    publicKey: bytea('public_key').notNull(),
    counter: bigint('counter', { mode: 'number' }).notNull(),
    transports: text('transports'),
    deviceType: text('device_type'),
    backedUp: boolean('backed_up').notNull(),
    revision: text('revision').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (table) => [index('sark_webauthn_credentials_sub_idx').on(table.sub)],
)
