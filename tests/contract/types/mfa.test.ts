import { expect, it } from 'vitest'

import { checkGeneratedTypes } from '../../helpers/typecheck'

it('preserves MFA request contracts, custom SQL mappings and environment requirements', async () => {
  const result = await checkGeneratedTypes(
    {
      'app.ts': `import { defineDatabase } from '@olivaw/sark/db/sqlite'
import { defineAuth } from '@olivaw/sark/auth'
import { defineMfa } from '@olivaw/sark/auth/mfa'
import { defineTotp } from '@olivaw/sark/auth/totp'
import { sqlTotp } from '@olivaw/sark/auth/totp/sqlite'
import { sqliteTable, text, integer, blob } from 'drizzle-orm/sqlite-core'
const factors = sqliteTable('custom_factors', {
  sub: text('account_id').primaryKey(), factorId: text('factor').notNull(), secret: blob('encrypted', { mode: 'buffer' }).notNull(),
  algorithm: text('algorithm').notNull(), digits: integer('digits').notNull(), period: integer('period').notNull(), lastStep: integer('last_step').notNull(), revision: text('revision').notNull(), enabledAt: integer('enabled_at').notNull(),
})
export const database = defineDatabase({ filename: ':memory:' })
export const auth = defineAuth((env: { SESSION_KEY: string }) => ({ secret: env.SESSION_KEY }))
export const mfa = defineMfa((env: { TTL: number }) => ({ challenge: { ttl: env.TTL } }))
export const totp = defineTotp((env: { TOTP_KEY: Uint8Array }) => ({ issuer: 'Test', keys: { current: { id: 'key', key: env.TOTP_KEY } }, store: sqlTotp({ database, tables: { factors } }) }))
// @ts-expect-error A table without the required factor columns is not a compatible mapping.
sqlTotp({ database, tables: { factors: sqliteTable('incomplete', { sub: text('id').primaryKey() }) } })`,
      'api/test.post.ts': `import { route } from '@olivaw/sark'
export default route().handler(async c => {
  await c.var.mfa.complete('challenge', { kind: 'totp', code: '123456' })
  // @ts-expect-error An unselected WebAuthn factor is not a valid proof.
  c.var.mfa.complete('challenge', { kind: 'webauthn', response: {} })
  // @ts-expect-error The application has no WebAuthn request service.
  c.var.webauthn.beginSignIn()
  // @ts-expect-error Request services do not expose maintenance methods.
  c.var.totp.reencrypt('alice')
  return c.var.totp.isEnabled('alice')
})`,
      'contracts.ts': `import { createApp } from '@olivaw/sark'
import { definition } from './.build/app'
// @ts-expect-error All declaration factory environments are required.
createApp(definition)
// @ts-expect-error The TOTP factory environment is required too.
createApp(definition, { env: { SESSION_KEY: 'test', TTL: 1000 } })
const app = await createApp(definition, { env: { SESSION_KEY: 'test', TTL: 1000, TOTP_KEY: new Uint8Array(32) } })
app.totp.reencrypt('alice')
// @ts-expect-error MFA is request-bound and has no instance service.
app.mfa.beginStepUp()
`,
    },
    { customHost: true },
  )
  expect(result.status, result.output).toBe(0)
})

it('uses the upstream WebAuthn response type only for selected WebAuthn applications', async () => {
  const result = await checkGeneratedTypes({
    'app.ts': `import { defineAuth } from '@olivaw/sark/auth'
import { defineWebAuthn } from '@olivaw/sark/auth/webauthn'
export const auth = defineAuth({ secret: 'long-enough-session-signing-secret-for-tests' })
export const webauthn = defineWebAuthn({ rpId: 'example.com', rpName: 'Test', origins: ['https://example.com'], user: sub => ({ userName: sub, displayName: sub }), store: { create: () => ({ value: {
  getOrCreateUserHandle: async sub => sub, findCredential: async () => null, listCredentials: async () => [], insertCredential: async () => true, updateCredential: async () => true, removeCredential: async () => true,
} }) } })`,
    'api/test.post.ts': `import { route } from '@olivaw/sark'
import type { AuthenticationResponseJSON } from '@olivaw/sark/auth/webauthn'
declare const response: AuthenticationResponseJSON
export default route().handler(async c => {
  c.var.mfa.complete('challenge', { kind: 'webauthn', response })
  // @ts-expect-error The proof must be a complete upstream response.
  c.var.mfa.complete('challenge', { kind: 'webauthn', response: { id: 'only-an-id' } })
  // @ts-expect-error TOTP is not selected.
  c.var.totp.beginEnrollment()
  return c.var.webauthn.beginSignIn()
})`,
  })
  expect(result.status, result.output).toBe(0)
})

it.each([
  [
    "import { defineTotp } from '@olivaw/sark/auth/totp'; export const totp = defineTotp({ issuer: 'test', keys: { current: { id: 'key', key: new Uint8Array(32) } }, store: { create: () => ({ value: { read: async () => null, commit: async () => true } }) } })",
    'require an auth',
  ],
  [
    "import { defineAuth } from '@olivaw/sark/auth'; import { defineMfa } from '@olivaw/sark/auth/mfa'; export const auth = defineAuth({ secret: 'long-enough-secret-for-test-session-signing' }); export const mfa = defineMfa({})",
    'at least one configured factor',
  ],
])('rejects incomplete factor composition during generation', async (app, message) => {
  await expect(checkGeneratedTypes({ 'app.ts': app })).rejects.toThrow(message)
})
