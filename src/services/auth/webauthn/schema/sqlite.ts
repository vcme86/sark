/**
 * SQLite table schemas for WebAuthn subjects and registered credentials.
 *
 * @module
 */

import { blob, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const webauthnSubjects = sqliteTable('webauthn_subjects', {
  sub: text('sub').primaryKey(),
  userHandle: text('user_handle').notNull().unique(),
})

export const webauthnCredentials = sqliteTable(
  'webauthn_credentials',
  {
    credentialId: text('credential_id').primaryKey(),
    sub: text('sub').notNull(),
    userHandle: text('user_handle').notNull(),
    publicKey: blob('public_key', { mode: 'buffer' }).notNull(),
    counter: integer('counter').notNull(),
    transports: text('transports'),
    deviceType: text('device_type'),
    backedUp: integer('backed_up', { mode: 'boolean' }).notNull(),
    revision: text('revision').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [index('webauthn_credentials_sub_idx').on(table.sub)],
)
