import { getLogger } from '@logtape/logtape'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { PostgresRecoveryStore } from '../../src/services/auth/recovery/db/postgres'
import { recovery } from '../../src/services/auth/recovery/schema/postgres'
import { PostgresAuthStateStore, sqlAuthState } from '../../src/services/auth/state/postgres'
import { attempts, challenges } from '../../src/services/auth/state/schema/postgres'
import type { AuthFlow } from '../../src/services/auth/state/types'
import { PostgresTotpStore } from '../../src/services/auth/totp/db/postgres'
import { factors } from '../../src/services/auth/totp/schema/postgres'
import { PostgresWebAuthnStore } from '../../src/services/auth/webauthn/db/postgres'
import { credentials, subjects } from '../../src/services/auth/webauthn/schema/postgres'
import { defineDatabase } from '../../src/services/db/postgres'
import { postgresTableMetadata } from '../helpers/auth-schema'

const url = process.env.SARK_TEST_POSTGRES_URL
// The caller supplies an isolated PostgreSQL database; no server is installed by this suite.
const flow = (id: string): AuthFlow => ({
  id,
  revision: crypto.randomUUID(),
  purpose: 'login',
  sub: 'alice',
  createdAt: Date.now(),
  expiresAt: Date.now() + 60_000,
  attempts: 0,
  maxAttempts: 3,
  status: 'pending',
  data: {},
})

describe.skipIf(!url)('MFA PostgreSQL atomic storage', () => {
  const client = postgres(url!, { max: 4 })
  const db = drizzle(client)
  const state = new PostgresAuthStateStore(db)
  beforeAll(async () => {
    await client.unsafe(`CREATE TABLE sark_mfa_challenges (id text PRIMARY KEY, revision text NOT NULL, purpose text NOT NULL, sub text, created_at bigint NOT NULL, expires_at bigint NOT NULL, attempts integer NOT NULL, max_attempts integer NOT NULL, status text NOT NULL, claim_id text, data text NOT NULL);
      CREATE TABLE sark_mfa_attempts (account_id text PRIMARY KEY, count integer NOT NULL, expires_at bigint NOT NULL);
      CREATE TABLE sark_totp_factors (sub text PRIMARY KEY, revision text NOT NULL, factor_id text NOT NULL, algorithm text NOT NULL, digits integer NOT NULL, period integer NOT NULL, secret bytea NOT NULL, last_step bigint NOT NULL, enabled_at bigint NOT NULL);
      CREATE TABLE sark_mfa_recovery (sub text PRIMARY KEY, hashes text NOT NULL, revision text NOT NULL);
      CREATE TABLE sark_webauthn_subjects (sub text PRIMARY KEY, user_handle text UNIQUE NOT NULL);
      CREATE TABLE sark_webauthn_credentials (credential_id text PRIMARY KEY, sub text NOT NULL, user_handle text NOT NULL, public_key bytea NOT NULL, counter bigint NOT NULL, transports text, device_type text, backed_up boolean NOT NULL, revision text NOT NULL, created_at bigint NOT NULL);
      CREATE INDEX sark_mfa_challenges_expires_at_idx ON sark_mfa_challenges (expires_at);
      CREATE INDEX sark_mfa_attempts_expires_at_idx ON sark_mfa_attempts (expires_at);
      CREATE INDEX sark_webauthn_credentials_sub_idx ON sark_webauthn_credentials (sub);`)
  })
  beforeEach(async () => {
    await client.unsafe(
      'TRUNCATE sark_mfa_challenges, sark_mfa_attempts, sark_totp_factors, sark_mfa_recovery, sark_webauthn_subjects, sark_webauthn_credentials',
    )
  })
  afterAll(async () => {
    try {
      await client.unsafe(
        'DROP TABLE sark_mfa_challenges, sark_mfa_attempts, sark_totp_factors, sark_mfa_recovery, sark_webauthn_subjects, sark_webauthn_credentials',
      )
    } finally {
      await client.end({ timeout: 0 })
    }
  })

  it('matches real schema column types and indexes, rather than validating a different test layout', async () => {
    for (const table of [challenges, attempts, factors, recovery, subjects, credentials]) {
      const expected = postgresTableMetadata(table)
      const columns =
        await client`select column_name as name, data_type as type, (is_nullable = 'NO') as notnull from information_schema.columns where table_schema = 'public' and table_name = ${expected.name}`
      expect(columns.toSorted((a, b) => a.name.localeCompare(b.name))).toEqual(
        expected.columns.toSorted((a, b) => a.name.localeCompare(b.name)),
      )
      const indexes =
        await client`select indexname as name from pg_indexes where schemaname = 'public' and tablename = ${expected.name}`
      expect(indexes.map((row) => row.name)).toEqual(expect.arrayContaining(expected.indexes))
    }
  })

  it('serializes the first account window across different challenges and spends nothing for zero-row claims', async () => {
    await Promise.all(['first', 'second'].map((id) => state.create(flow(id))))
    const now = Date.now()
    const account = { sub: 'alice', purpose: 'login', maxAttempts: 1, window: 1000 }
    expect(await state.claim('missing', 'missing-claim', now, account)).toEqual({
      status: 'invalid',
    })
    expect(await db.select().from(attempts)).toEqual([])
    const claimed = await Promise.all(
      ['first', 'second'].map((id) => state.claim(id, id, now, account)),
    )
    expect(claimed.map((result) => result.status).toSorted()).toEqual(['claimed', 'limited'])
    expect(await db.select().from(attempts)).toMatchObject([{ count: 1, expiresAt: now + 1000 }])
    const index = claimed.findIndex((result) => result.status === 'claimed')
    const id = ['first', 'second'][index]
    expect(await state.release(id, 'wrong-owner', now)).toBe(false)
    expect(await state.release(id, id, now)).toBe(true)
    expect(await state.read(id)).toMatchObject({ attempts: 1, status: 'pending' })
    expect(await state.claim(id, 'after-limit', now, account)).toEqual({ status: 'limited' })
    expect((await state.claim(id, 'next-window', now + 1000, account)).status).toBe('claimed')
    expect(await state.consume(id, 'next-window', now + 1000)).toBe(true)
    expect((await state.claim(id, 'replay', now + 1000, account)).status).toBe('invalid')
  })

  it('round-trips binary factors and handles concurrent CAS updates without swallowing database errors', async () => {
    const totp = new PostgresTotpStore(db)
    const recoveryStore = new PostgresRecoveryStore(db)
    const webauthn = new PostgresWebAuthnStore(db)
    const record = {
      factorId: 'factor',
      secret: new Uint8Array([0, 128, 255]),
      algorithm: 'SHA1' as const,
      digits: 6,
      period: 30,
      lastStep: 10,
      revision: 'first',
      enabledAt: Date.now(),
    }
    expect(await totp.commit('alice', null, record)).toBe(true)
    expect(await totp.read('alice')).toEqual(record)
    const updates = await Promise.all(
      ['a', 'b'].map((revision) => totp.commit('alice', 'first', { ...record, revision })),
    )
    expect(updates.toSorted()).toEqual([false, true])
    expect(
      await recoveryStore.commit('alice', null, { revision: 'r', hashes: ['one', 'two'] }),
    ).toBe(true)
    expect(
      (
        await Promise.all(
          ['a', 'b'].map((revision) =>
            recoveryStore.commit('alice', 'r', { revision, hashes: ['two'] }),
          ),
        )
      ).toSorted(),
    ).toEqual([false, true])
    const handles = await Promise.all([
      webauthn.getOrCreateUserHandle('alice'),
      webauthn.getOrCreateUserHandle('alice'),
    ])
    expect(handles[0]).toBe(handles[1])
    const credential = {
      credentialId: 'key',
      sub: 'alice',
      userHandle: handles[0],
      publicKey: new Uint8Array([0, 255]),
      counter: 0xffffffff,
      revision: 'first',
      backedUp: true,
      createdAt: Date.now(),
      transports: ['internal'],
      deviceType: 'multiDevice',
    }
    expect(await webauthn.insertCredential(credential)).toBe(true)
    expect(await webauthn.findCredential('key')).toEqual(credential)
    expect(await webauthn.removeCredential('key', 'someone-else', 'first')).toBe(false)
    expect(await webauthn.removeCredential('key', 'alice', 'first')).toBe(true)
    await client.unsafe('DROP TABLE sark_totp_factors')
    try {
      await expect(totp.commit('alice', null, record)).rejects.toThrow()
    } finally {
      await client.unsafe(
        'CREATE TABLE sark_totp_factors (sub text PRIMARY KEY, revision text NOT NULL, factor_id text NOT NULL, algorithm text NOT NULL, digits integer NOT NULL, period integer NOT NULL, secret bytea NOT NULL, last_step bigint NOT NULL, enabled_at bigint NOT NULL)',
      )
    }
  })
  it('round-trips opaque protocol metadata and returns the winner of concurrent binding', async () => {
    const current = flow('protocol')
    await state.create(current)
    const [first, second] = await Promise.all([
      state.bindProtocol(current.id, current.revision, { nonce: 'first' }, Date.now()),
      state.bindProtocol(current.id, current.revision, { nonce: 'second' }, Date.now()),
    ])
    expect(first?.protocol).toEqual(second?.protocol)
    expect(await state.read(current.id)).toMatchObject({ data: {}, protocol: first!.protocol })
  })

  it('bounds expired-state cleanup and catches up on the next write without deleting live windows', async () => {
    const now = Date.now()
    await db.insert(challenges).values(
      Array.from({ length: 105 }, (_, index) => ({
        ...flow(`expired-${index}`),
        expiresAt: now - 1,
        data: '{}',
      })),
    )
    await db.insert(attempts).values({ accountId: 'live', count: 1, expiresAt: now + 60000 })
    const database = defineDatabase({ url: url! })
    const work: Promise<unknown>[] = []
    const initialized = await sqlAuthState({ database }).create({
      target: 'node',
      resources: { db },
      resourceDeclarations: { db: database },
      signal: new AbortController().signal,
      logger: getLogger(['test']),
      waitUntil: (promise) => {
        work.push(promise)
      },
    })
    expect(await initialized.value.read('expired-0')).toBeNull()
    await initialized.value.create(flow('cleanup-trigger-1'))
    await Promise.all(work)
    const expired = () =>
      db
        .select({ count: sql<number>`count(*)::integer` })
        .from(challenges)
        .where(sql`${challenges.expiresAt} < ${now}`)
    expect((await expired())[0].count).toBe(5)
    await initialized.value.create(flow('cleanup-trigger-2'))
    await Promise.all(work)
    expect((await expired())[0].count).toBe(0)
    expect(await db.select().from(attempts)).toMatchObject([{ accountId: 'live', count: 1 }])
  })
})
