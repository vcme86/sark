import { getLogger } from '@logtape/logtape'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { blob, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { afterAll, describe, expect, it } from 'vitest'

import { createApp } from '../../src/app/create'
import { createDefinition } from '../../src/app/definition'
import { createMfaAssembly } from '../../src/features/auth/mfa/assembly'
import { SqlRecoveryStore } from '../../src/features/auth/recovery/db/sql'
import { recoveryCodeSets as defaultRecoveryTable } from '../../src/features/auth/recovery/schema/sqlite'
import { createAuthAssembly } from '../../src/features/auth/session/assembly'
import { defineAuth } from '../../src/features/auth/session/config'
import { createTotpFactor } from '../../src/features/auth/totp/assembly'
import { defineTotp } from '../../src/features/auth/totp/config'
import { decryptTotpSecret, encryptTotpSecret } from '../../src/features/auth/totp/crypto'
import { SqlTotpStore } from '../../src/features/auth/totp/db/sql'
import { sqlTotp } from '../../src/features/auth/totp/db/sqlite'
import { totpFactors as defaultFactorsTable } from '../../src/features/auth/totp/schema/sqlite'
import type { TotpRecord } from '../../src/features/auth/totp/types'
import { SqlWebAuthnStore } from '../../src/features/auth/webauthn/db/sql'
import {
  webauthnCredentials as defaultCredentialsTable,
  webauthnSubjects as defaultSubjectsTable,
} from '../../src/features/auth/webauthn/schema/sqlite'
import type { WebAuthnRecord } from '../../src/features/auth/webauthn/types'
import { defineDatabase as definePostgres } from '../../src/features/db/postgres'
import { defineDatabase } from '../../src/features/db/sqlite'
import { checkAuthStores } from '../helpers/auth-store-contracts'

describe('MFA SQLite Stores Contract & Concurrency', () => {
  const sqlite = new Database(':memory:')
  const db = drizzle(sqlite)

  afterAll(() => {
    sqlite.close()
  })

  // Initialize SQLite DDL tables matching schemas
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS recovery_code_sets (
      sub TEXT PRIMARY KEY NOT NULL,
      hashes TEXT NOT NULL,
      revision TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS totp_factors (
      sub TEXT PRIMARY KEY NOT NULL,
      factor_id TEXT NOT NULL,
      algorithm TEXT NOT NULL,
      digits INTEGER NOT NULL,
      period INTEGER NOT NULL,
      secret BLOB NOT NULL,
      last_step INTEGER,
      revision TEXT NOT NULL,
      enabled_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS webauthn_subjects (
      sub TEXT PRIMARY KEY NOT NULL,
      user_handle TEXT UNIQUE NOT NULL
    );
    CREATE TABLE IF NOT EXISTS webauthn_credentials (
      credential_id TEXT PRIMARY KEY NOT NULL,
      sub TEXT NOT NULL,
      user_handle TEXT NOT NULL,
      public_key BLOB NOT NULL,
      counter INTEGER NOT NULL,
      transports TEXT,
      device_type TEXT,
      backed_up INTEGER NOT NULL,
      revision TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS webauthn_credentials_sub_idx ON webauthn_credentials(sub);
  `)

  it('shares the SQLite/D1 persistence contract', () =>
    checkAuthStores(new SqlTotpStore(db), new SqlRecoveryStore(db), new SqlWebAuthnStore(db)))

  describe('SqlTotpStore', () => {
    const store = new SqlTotpStore(db, defaultFactorsTable)

    it('inserts, conditionally advances and removes one encrypted factor', async () => {
      const record: TotpRecord = {
        factorId: 'fac_123',
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        secret: new Uint8Array([1, 2, 3, 4]),
        lastStep: 100,
        revision: 'rev-1',
        enabledAt: 123456789,
      }

      // Initial commit requires expectedRevision: null
      const committed = await store.commit('sub_totp_1', null, record)
      expect(committed).toBe(true)

      // Concurrent commit with null expectedRevision fails
      const duplicate = await store.commit('sub_totp_1', null, record)
      expect(duplicate).toBe(false)

      const read = await store.read('sub_totp_1')
      expect(read).not.toBeNull()
      expect(read?.factorId).toBe('fac_123')
      expect(read?.lastStep).toBe(100)
      expect(read?.revision).toBe('rev-1')
      expect(Array.from(read!.secret)).toEqual([1, 2, 3, 4])

      const initial = (await store.read('sub_totp_1'))!

      const staleUpdate: TotpRecord = {
        ...initial,
        lastStep: 101,
        revision: 'rev-stale',
      }
      const staleRes = await store.commit('sub_totp_1', 'rev-wrong', staleUpdate)
      expect(staleRes).toBe(false)

      const validUpdate: TotpRecord = {
        ...initial,
        lastStep: 101,
        revision: 'rev-2',
      }
      const validRes = await store.commit('sub_totp_1', initial.revision, validUpdate)
      expect(validRes).toBe(true)

      const updated = await store.read('sub_totp_1')
      expect(updated?.lastStep).toBe(101)
      expect(updated?.revision).toBe('rev-2')

      const current = (await store.read('sub_totp_1'))!
      const removed = await store.commit('sub_totp_1', current.revision, null)
      expect(removed).toBe(true)

      expect(await store.read('sub_totp_1')).toBeNull()
    })
  })

  it('rotates an existing encrypted factor through the real instance maintenance API', async () => {
    const old = { id: 'old', key: new Uint8Array(32).fill(1) }
    const current = { id: 'current', key: new Uint8Array(32).fill(2) }
    const store = new SqlTotpStore(db)
    const original: TotpRecord = {
      factorId: 'factor',
      secret: await encryptTotpSecret('JBSWY3DPEHPK3PXP', old, 'rotating', 'factor'),
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      lastStep: 123,
      revision: 'old-revision',
      enabledAt: Date.now(),
    }
    await store.commit('rotating', null, original)
    const factor = createTotpFactor(
      defineTotp({
        issuer: 'test',
        keys: { current, retired: [old] },
        store: { create: () => ({ value: store }) },
      }),
    )
    const app = await createApp(
      createDefinition({
        services: {
          auth: createAuthAssembly(
            defineAuth({ secret: 'long-enough-session-signing-secret-for-test' }),
          ),
          mfa: createMfaAssembly({ factors: [factor] }),
          totp: factor.maintenance,
        },
      }),
    )
    try {
      expect(await app.totp.reencrypt('rotating')).toBe(true)
      const changed = (await store.read('rotating'))!
      expect(changed.revision).not.toBe(original.revision)
      expect(changed.lastStep).toBe(original.lastStep)
      expect(changed.factorId).toBe(original.factorId)
      expect(
        await decryptTotpSecret(
          changed.secret,
          new Map([[current.id, current]]),
          'rotating',
          changed.factorId,
        ),
      ).toMatchObject({ keyId: 'current', secret: 'JBSWY3DPEHPK3PXP' })
      expect(await app.totp.reencrypt('missing')).toBe(false)
    } finally {
      await app.close()
    }
    expect(sqlite.open).toBe(true)
  })

  describe('SqlRecoveryStore', () => {
    const store = new SqlRecoveryStore(db, defaultRecoveryTable)

    it('commits initial recovery hashes and updates under revision match', async () => {
      const committed = await store.commit('user_rec_1', null, {
        revision: 'rev-rec-1',
        hashes: ['hashA', 'hashB'],
      })
      expect(committed).toBe(true)

      const read1 = await store.read('user_rec_1')
      expect(read1?.revision).toBe('rev-rec-1')
      expect(read1?.hashes).toEqual(['hashA', 'hashB'])

      // Update with mismatched revision fails
      const failed = await store.commit('user_rec_1', 'wrong-rev', {
        revision: 'rev-rec-2',
        hashes: ['hashB'],
      })
      expect(failed).toBe(false)

      // Update with correct revision succeeds
      const updated = await store.commit('user_rec_1', 'rev-rec-1', {
        revision: 'rev-rec-2',
        hashes: ['hashB'],
      })
      expect(updated).toBe(true)

      const read2 = await store.read('user_rec_1')
      expect(read2?.hashes).toEqual(['hashB'])
    })
  })

  describe('SqlWebAuthnStore', () => {
    const store = new SqlWebAuthnStore(db, defaultSubjectsTable, defaultCredentialsTable)

    it('generates and returns stable user handle for same sub', async () => {
      const handle1 = await store.getOrCreateUserHandle('sub_webauthn_1')
      expect(handle1).toBeTruthy()

      const handle2 = await store.getOrCreateUserHandle('sub_webauthn_1')
      expect(handle2).toBe(handle1)

      const otherHandle = await store.getOrCreateUserHandle('sub_webauthn_2')
      expect(otherHandle).not.toBe(handle1)
    })

    it('inserts, updates counter, and removes credentials', async () => {
      const cred1: WebAuthnRecord = {
        credentialId: 'cred_abc_123',
        sub: 'sub_webauthn_1',
        userHandle: 'handle_1',
        publicKey: new Uint8Array([10, 20, 30]),
        counter: 1,
        transports: ['internal'],
        deviceType: 'singleDevice',
        backedUp: false,
        revision: 'rev-cred-1',
        createdAt: 1000,
      }

      const inserted = await store.insertCredential(cred1)
      expect(inserted).toBe(true)

      // Duplicate insert fails
      expect(await store.insertCredential(cred1)).toBe(false)

      const found = await store.findCredential('cred_abc_123')
      expect(found).not.toBeNull()
      expect(found?.counter).toBe(1)
      expect(Array.from(found!.publicKey)).toEqual([10, 20, 30])

      // Conditional update counter
      const updated = await store.updateCredential('cred_abc_123', 'sub_webauthn_1', 'rev-cred-1', {
        ...cred1,
        counter: 2,
        revision: 'rev-cred-2',
      })
      expect(updated).toBe(true)

      // Stale revision update rejected
      const stale = await store.updateCredential('cred_abc_123', 'sub_webauthn_1', 'rev-cred-1', {
        ...cred1,
        counter: 3,
        revision: 'rev-cred-3',
      })
      expect(stale).toBe(false)

      // List credentials for user
      const list = await store.listCredentials('sub_webauthn_1')
      expect(list).toHaveLength(1)
      expect(list[0].credentialId).toBe('cred_abc_123')

      // Remove credential
      const removed = await store.removeCredential('cred_abc_123', 'sub_webauthn_1', 'rev-cred-2')
      expect(removed).toBe(true)

      const afterRemove = await store.findCredential('cred_abc_123')
      expect(afterRemove).toBeNull()
    })
  })
})

it('borrows the selected database and preserves custom physical factor table and column names', async () => {
  const database = defineDatabase({ filename: ':memory:' })
  const factors = sqliteTable('account_factors', {
    sub: text('account_id').primaryKey(),
    factorId: text('id').notNull(),
    secret: blob('ciphertext', { mode: 'buffer' }).notNull(),
    algorithm: text('hash').notNull(),
    digits: integer('length').notNull(),
    period: integer('seconds').notNull(),
    lastStep: integer('used_step').notNull(),
    revision: text('version').notNull(),
    enabledAt: integer('enabled').notNull(),
  })
  const declaration = sqlTotp({ database, tables: { factors } })
  const app = await createApp(createDefinition({ resources: { selected: database } }))
  try {
    app.selected.$client.exec(
      'CREATE TABLE account_factors (account_id TEXT PRIMARY KEY, id TEXT NOT NULL, ciphertext BLOB NOT NULL, hash TEXT NOT NULL, length INTEGER NOT NULL, seconds INTEGER NOT NULL, used_step INTEGER NOT NULL, version TEXT NOT NULL, enabled INTEGER NOT NULL)',
    )
    const initialized = await declaration.create({
      resources: { selected: app.selected },
      resourceDeclarations: { selected: database },
      target: 'node',
      logger: getLogger(['test']),
      signal: new AbortController().signal,
      waitUntil: () => {},
    })
    expect(initialized.dispose).toBeUndefined()
    const record = {
      factorId: 'id',
      secret: new Uint8Array([0, 128, 255]),
      algorithm: 'SHA256' as const,
      digits: 8,
      period: 60,
      lastStep: 1,
      revision: 'v1',
      enabledAt: Date.now(),
    }
    expect(
      await initialized.value.commit('alice', null, record, { logger: getLogger(['test']) }),
    ).toBe(true)
    expect(await initialized.value.read('alice', { logger: getLogger(['test']) })).toEqual(record)
    expect(app.selected.$client.open).toBe(true)
  } finally {
    await app.close()
  }
  expect(app.selected.$client.open).toBe(false)
  expect(() => sqlTotp({ database: definePostgres({ url: 'postgres://not-opened' }) })).toThrow(
    'sqlite database',
  )
})
