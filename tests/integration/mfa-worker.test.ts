import { join, relative } from 'node:path'

import { ScureBase32Plugin } from '@otplib/plugin-base32-scure'
import { WebCryptoPlugin } from '@otplib/plugin-crypto-web'
import { TOTP } from '@otplib/totp'
import { preview, type PreviewServer } from 'vite'
import { expect, it } from 'vitest'

import { recoveryCodeSets } from '../../src/entries/auth/recovery-d1'
import { authAttemptWindows, authChallenges } from '../../src/entries/auth/state-d1'
import { totpFactors } from '../../src/entries/auth/totp-d1'
import { webauthnCredentials, webauthnSubjects } from '../../src/entries/auth/webauthn-d1'
import { sqliteTableMetadata } from '../helpers/auth-schema'
import { createProject, projectRoot, runProjectCli, serverUrl } from '../helpers/project'
import { createCredential } from '../helpers/webauthn'

const json = async (response: Response) => {
  const text = await response.text()
  expect(response.status, text).toBe(200)
  return JSON.parse(text)
}

it('executes generated MFA, signed WebAuthn and D1 account transitions in real workerd', async () => {
  const project = createProject()
  let server: PreviewServer | undefined
  project.write(
    'app.ts',
    `import { defineApp } from '@olivaw/sark'
import { defineDatabase } from '@olivaw/sark/db/d1'
import { defineAuth } from '@olivaw/sark/auth'
import { defineMfa } from '@olivaw/sark/auth/mfa'
import { defineTotp } from '@olivaw/sark/auth/totp'
import { defineWebAuthn } from '@olivaw/sark/auth/webauthn'
import { sqlAuthState } from '@olivaw/sark/auth/state/d1'
import { sqlTotp } from '@olivaw/sark/auth/totp/d1'
import { sqlWebAuthn } from '@olivaw/sark/auth/webauthn/d1'
import { sqlRecovery } from '@olivaw/sark/auth/recovery/d1'
import type { D1Database } from '@cloudflare/workers-types'
export const app = defineApp({ csrf: false })
export const database = defineDatabase((env: { DB: D1Database }) => ({ binding: env.DB }))
export const auth = defineAuth({ secret: 'worker-session-signing-secret-for-tests-at-least-32-bytes' })
export const mfa = defineMfa({ state: sqlAuthState({ database }), recovery: { store: sqlRecovery({ database }) } })
export const totp = defineTotp({ issuer: 'Test', keys: { current: { id: 'key', key: new Uint8Array(32).fill(1) } }, store: sqlTotp({ database }) })
export const webauthn = defineWebAuthn({ rpId: 'auth.example.com', rpName: 'Test', origins: ['https://auth.example.com'], user: sub => ({ userName: sub, displayName: sub }), store: sqlWebAuthn({ database }), identity: sub => ({ sub, roles: ['reader'], claims: { plan: 'basic' } }) })`,
  )
  const storeContractsPath = relative(
    join(project.root, 'api'),
    join(projectRoot, 'tests/helpers/auth-store-contracts'),
  ).replace(/\\/g, '/')
  project.write(
    'api/test.post.ts',
    `import { route, getLogger } from '@olivaw/sark'
import { sqlAuthState } from '@olivaw/sark/auth/state/d1'
import { database } from '../app'
import { sqlTotp } from '@olivaw/sark/auth/totp/d1'
import { sqlRecovery } from '@olivaw/sark/auth/recovery/d1'
import { sqlWebAuthn } from '@olivaw/sark/auth/webauthn/d1'
import { checkAuthStores } from ${JSON.stringify(storeContractsPath)}
export default route().handler(async c => {
  const input = await c.req.json()
  switch(input.op) {
    case 'setup': {
      const statements = [
        'CREATE TABLE auth_challenges (id TEXT PRIMARY KEY NOT NULL, revision TEXT NOT NULL, purpose TEXT NOT NULL, sub TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL, max_attempts INTEGER NOT NULL, status TEXT NOT NULL, claim_id TEXT, data TEXT NOT NULL)',
        'CREATE INDEX auth_challenges_expires_at_idx ON auth_challenges(expires_at)',
        'CREATE TABLE auth_attempt_windows (window_key TEXT PRIMARY KEY NOT NULL, count INTEGER NOT NULL, expires_at INTEGER NOT NULL)',
        'CREATE INDEX auth_attempt_windows_expires_at_idx ON auth_attempt_windows(expires_at)',
        'CREATE TABLE totp_factors (sub TEXT PRIMARY KEY NOT NULL, revision TEXT NOT NULL, factor_id TEXT NOT NULL, algorithm TEXT NOT NULL, digits INTEGER NOT NULL, period INTEGER NOT NULL, secret BLOB NOT NULL, last_step INTEGER NOT NULL, enabled_at INTEGER NOT NULL)',
        'CREATE TABLE recovery_code_sets (sub TEXT PRIMARY KEY NOT NULL, hashes TEXT NOT NULL, revision TEXT NOT NULL)',
        'CREATE TABLE webauthn_subjects (sub TEXT PRIMARY KEY NOT NULL, user_handle TEXT UNIQUE NOT NULL)',
        'CREATE TABLE webauthn_credentials (credential_id TEXT PRIMARY KEY NOT NULL, sub TEXT NOT NULL, user_handle TEXT NOT NULL, public_key BLOB NOT NULL, counter INTEGER NOT NULL, transports TEXT, device_type TEXT, backed_up INTEGER NOT NULL, revision TEXT NOT NULL, created_at INTEGER NOT NULL)',
        'CREATE INDEX webauthn_credentials_sub_idx ON webauthn_credentials(sub)',
      ]
      await c.var.db.$client.batch(statements.map(statement => c.var.db.$client.prepare(statement)))
      return { ready: true }
    }
    case 'store-contracts': {
      const context = { env: c.env, resources: { db: c.var.db }, resourceDeclarations: { db: database }, target: 'cloudflare' as const, logger: getLogger(), signal: c.req.raw.signal, waitUntil: p => c.executionCtx.waitUntil(p) }
      const totp = await sqlTotp({ database }).create(context)
      const recovery = await sqlRecovery({ database }).create(context)
      const webauthn = await sqlWebAuthn({ database }).create(context)
      await checkAuthStores(totp.value, recovery.value, webauthn.value)
      return { passed: true }
    }
    case 'schema': {
      const result = []
      for (const name of input.tables) {
        const columns = await c.var.db.$client.prepare('SELECT name, type, "notnull", pk FROM pragma_table_info(?)').bind(name).all()
        const indexes = await c.var.db.$client.prepare('SELECT name FROM pragma_index_list(?)').bind(name).all()
        result.push({ name, columns: columns.results, indexes: indexes.results.map(row => row.name) })
      }
      return result
    }
    case 'login': return c.var.mfa.beginSignIn({ sub: 'alice', amr: ['pwd'] })
    case 'register': return c.var.webauthn.beginEnrollment()
    case 'confirm': {
      const result = await c.var.webauthn.confirmEnrollment(input.challenge, input.response)
      return { ...result, ...(input.recovery ? await c.var.mfa.regenerateRecoveryCodes() : {}) }
    }
    case 'passwordless': return c.var.webauthn.beginSignIn()
    case 'options': return c.var.webauthn.beginAuthentication(input.challenge)
    case 'confirm-totp': return c.var.totp.confirmEnrollment(input.challenge, input.code)
    case 'complete': return c.var.mfa.complete(input.challenge, input.proof ?? { kind: 'webauthn', response: input.response })
    case 'recovery': return c.var.mfa.regenerateRecoveryCodes()
    case 'profile': return c.var.auth.identity
    case 'totp': return c.var.totp.beginEnrollment()
    case 'cleanup': {
      const now = Date.now()
      await c.var.db.$client.prepare("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 105) INSERT INTO auth_challenges SELECT 'expired-' || x, 'r', 'sign-in', 'cleanup', 0, ?, 0, 5, 'verifying', 'old', '{}' FROM n").bind(now - 1).run()
      await c.var.db.$client.prepare("INSERT INTO auth_attempt_windows VALUES ('cleanup-live', 1, ?)").bind(now + 60000).run()
      const work: Promise<unknown>[] = []
      const { value: state } = await sqlAuthState({ database }).create({ env: c.env, resources: { db: c.var.db }, resourceDeclarations: { db: database }, target: 'cloudflare', logger: getLogger('test'), signal: c.req.raw.signal, waitUntil: promise => { work.push(promise); c.executionCtx.waitUntil(promise) } })
      const expiredRead = await state.read('expired-1')
      for (const id of ['cleanup-first', 'cleanup-second']) {
        await state.create({ id, revision: id, purpose: 'sign-in', sub: 'cleanup', createdAt: now, expiresAt: now + 60000, maxAttempts: 5, attempts: 0, status: 'pending', data: {} })
        await Promise.all(work)
        const count = await c.var.db.$client.prepare("SELECT count(*) AS count FROM auth_challenges WHERE id LIKE 'expired-%'").first()
        if (id === 'cleanup-first' && count.count !== 5) throw new Error('Cleanup exceeded or failed its first batch')
      }
      const remaining = await c.var.db.$client.prepare("SELECT count(*) AS count FROM auth_challenges WHERE id LIKE 'expired-%'").first()
      const live = await c.var.db.$client.prepare("SELECT count FROM auth_attempt_windows WHERE window_key = 'cleanup-live'").first()
      return { expiredRead, remaining, live }
    }
    case 'budget': {
      try {
      const { value: state } = await sqlAuthState({ database }).create({ env: c.env, resources: { db: c.var.db }, resourceDeclarations: { db: database }, target: 'cloudflare', logger: getLogger('test'), signal: c.req.raw.signal, waitUntil: promise => c.executionCtx.waitUntil(promise) })
      const now = Date.now()
      const account = { sub: 'budget', purpose: 'sign-in', window: 1000, maxAttempts: 1 }
      for (const id of ['first', 'second']) await state.create({ id, revision: id, purpose: 'sign-in', sub: 'budget', createdAt: now, expiresAt: now + 60000, maxAttempts: 3, attempts: 0, status: 'pending', data: {} })
      const missing = await state.claim('missing', 'missing', now, account)
      const before = await c.var.db.$client.prepare('SELECT count(*) AS count FROM auth_attempt_windows').first()
      const results = await Promise.all(['first', 'second'].map(id => state.claim(id, id, now, account)))
      const winner = ['first', 'second'][results.findIndex(result => result.status === 'claimed')]
      const release = await state.release(winner, winner, now)
      const limited = await state.claim(winner, 'limited', now, account)
      const next = await state.claim(winner, 'next', now + 1000, account)
      const consumed = await state.consume(winner, 'next', now + 1000)
      const replay = await state.claim(winner, 'replay', now + 1000, account)
      return { missing, before, statuses: results.map(result => result.status).toSorted(), release, limited, next: next.status, consumed, replay }
      } catch (error) { return c.json({ failure: String(error), cause: String(error.cause) }, 500) }
    }
    default: return c.text('Unknown test operation', 400)
  }
})`,
  )
  project.write(
    'vite.config.mts',
    `import { sark } from '@olivaw/sark/vite'
import { cloudflare } from '@cloudflare/vite-plugin'
export default { cacheDir: '.build/vite-cache', plugins: [sark({ target: 'cloudflare' }), cloudflare({ viteEnvironment: { name: 'ssr' }, inspectorPort: false, persistState: false, remoteBindings: false })] }`,
  )
  project.write(
    'wrangler.jsonc',
    JSON.stringify({
      name: 'mfa-contract',
      main: '.build/worker.ts',
      compatibility_date: '2026-10-01',
      d1_databases: [{ binding: 'DB', database_name: 'mfa-contract', database_id: 'mfa-test' }],
    }),
  )
  try {
    const built = runProjectCli(project.root, ['build'], { NODE_ENV: 'production' })
    expect(built.status, built.stdout + built.stderr).toBe(0)
    server = await preview({
      root: project.root,
      logLevel: 'silent',
      preview: { host: '127.0.0.1', port: 0 },
    })
    const endpoint = `${serverUrl(server.httpServer)}/api/test`
    const call = (body: Record<string, unknown>, cookie = '') =>
      fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify(body),
      })
    await json(await call({ op: 'setup' }))
    expect(await json(await call({ op: 'store-contracts' }))).toEqual({ passed: true })

    const metadata = [
      authChallenges,
      authAttemptWindows,
      totpFactors,
      recoveryCodeSets,
      webauthnSubjects,
      webauthnCredentials,
    ].map(sqliteTableMetadata)
    const actual = await json(
      await call({ op: 'schema', tables: metadata.map((table) => table.name) }),
    )
    for (let i = 0; i < metadata.length; i++) {
      expect(actual[i].columns).toEqual(metadata[i].columns)
      expect(actual[i].indexes).toEqual(expect.arrayContaining(metadata[i].indexes))
    }
    expect(await json(await call({ op: 'budget' }))).toMatchObject({
      missing: { status: 'invalid' },
      before: { count: 0 },
      statuses: ['claimed', 'limited'],
      release: true,
      limited: { status: 'limited' },
      next: 'claimed',
      consumed: true,
      replay: { status: 'invalid' },
    })
    expect(await json(await call({ op: 'cleanup' }))).toEqual({
      expiredRead: null,
      remaining: { count: 0 },
      live: { count: 1 },
    })
    const login = await call({ op: 'login' })
    expect(await json(login)).toMatchObject({ status: 'authenticated' })
    const firstCookie = login.headers.getSetCookie()[0].split(';')[0]
    const credential = createCredential()
    const enrollment = await json(await call({ op: 'register' }, firstCookie))
    expect(
      await json(
        await call(
          {
            op: 'confirm',
            recovery: true,
            challenge: enrollment.challenge,
            response: credential.registration(enrollment.options),
          },
          firstCookie,
        ),
      ),
    ).toMatchObject({
      credentialId: credential.id,
      recoveryCodes: expect.arrayContaining([expect.any(String)]),
    })
    expect((await call({ op: 'recovery' }, firstCookie)).status).toBe(403)
    // A password-only session cannot add another factor after WebAuthn enrollment.
    expect((await call({ op: 'totp' }, firstCookie)).status).toBe(403)
    const passwordless = await json(await call({ op: 'passwordless' }))
    const completed = await call({
      op: 'complete',
      challenge: passwordless.challenge,
      response: credential.authentication(passwordless.options),
    })
    expect(await json(completed)).toMatchObject({
      identity: {
        sub: 'alice',
        roles: ['reader'],
        amr: ['pop'],
        auth: { method: 'webauthn', userVerified: true },
      },
    })
    const cookie = completed.headers.getSetCookie()[0].split(';')[0]
    expect(await json(await call({ op: 'profile' }, cookie))).toMatchObject({
      sub: 'alice',
      claims: { plan: 'basic' },
      auth: { method: 'webauthn', userVerified: true },
    })
    const secondStep = await json(await call({ op: 'login' }))
    const options = await Promise.all(
      [0, 1].map(() => call({ op: 'options', challenge: secondStep.challenge }).then(json)),
    )
    expect(options[0]).toEqual(options[1])
    expect(
      await json(
        await call({
          op: 'complete',
          challenge: secondStep.challenge,
          response: credential.authentication(options[0], { counter: 2 }),
        }),
      ),
    ).toMatchObject({ identity: { amr: ['pwd', 'pop'] } })
    const codes = await json(await call({ op: 'recovery' }, cookie))
    expect(codes.recoveryCodes).toHaveLength(10)
    const recoveryLogin = await json(await call({ op: 'login' }))
    expect(
      await json(
        await call({
          op: 'complete',
          challenge: recoveryLogin.challenge,
          proof: { kind: 'recovery', code: codes.recoveryCodes[0] },
        }),
      ),
    ).toMatchObject({ identity: { auth: { method: 'recovery' }, amr: ['pwd', 'otp'] } })
    const retry = await json(await call({ op: 'login' }))
    expect(
      (
        await call({
          op: 'complete',
          challenge: retry.challenge,
          proof: { kind: 'recovery', code: codes.recoveryCodes[0] },
        })
      ).status,
    ).toBe(400)
    const totp = await json(await call({ op: 'totp' }, cookie))
    const secret = new URL(totp.uri).searchParams.get('secret')!
    const generator = new TOTP({ crypto: new WebCryptoPlugin(), base32: new ScureBase32Plugin() })
    expect(
      await json(
        await call(
          {
            op: 'confirm-totp',
            challenge: totp.challenge,
            code: await generator.generate({ secret }),
          },
          cookie,
        ),
      ),
    ).toEqual({ enabled: true })
    const totpLogin = await json(await call({ op: 'login' }))
    const code = await generator.generate({ secret, epoch: Math.floor(Date.now() / 1000) + 30 })
    expect(
      await json(
        await call({
          op: 'complete',
          challenge: totpLogin.challenge,
          proof: { kind: 'totp', code },
        }),
      ),
    ).toMatchObject({ identity: { auth: { method: 'totp' }, amr: ['pwd', 'otp'] } })
    expect(
      (
        await call({
          op: 'complete',
          challenge: passwordless.challenge,
          response: credential.authentication(passwordless.options, { counter: 2 }),
        })
      ).status,
    ).toBe(400)
  } finally {
    try {
      await server?.close()
    } finally {
      project.remove()
    }
  }
}, 60_000)
