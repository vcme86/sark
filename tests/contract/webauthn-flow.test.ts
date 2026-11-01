import { getLogger } from '@logtape/logtape'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AuthenticationFacts } from '../../src/services/auth/contracts'
import { resolveMfaConfig } from '../../src/services/auth/mfa/config'
import { MfaServiceImpl } from '../../src/services/auth/mfa/service'
import { MemoryAuthStateStore } from '../../src/services/auth/state/memory'
import { resolveWebAuthnConfig } from '../../src/services/auth/webauthn/config'
import { SqliteWebAuthnStore } from '../../src/services/auth/webauthn/db/sqlite'
import {
  authenticationCredentialId,
  WebAuthnServiceImpl,
} from '../../src/services/auth/webauthn/service'
import { createCredential } from '../helpers/webauthn'

const close: Array<() => void> = []
afterEach(() => {
  vi.restoreAllMocks()
  close.splice(0).forEach((fn) => fn())
})

async function fixture(identityResolver?: (sub: string) => Promise<{ sub: string }>) {
  const sqlite = new Database(':memory:')
  close.push(() => sqlite.close())
  sqlite.exec(`CREATE TABLE sark_webauthn_subjects (sub TEXT PRIMARY KEY, user_handle TEXT UNIQUE NOT NULL);
    CREATE TABLE sark_webauthn_credentials (credential_id TEXT PRIMARY KEY, sub TEXT NOT NULL, user_handle TEXT NOT NULL, public_key BLOB NOT NULL, counter INTEGER NOT NULL, transports TEXT, device_type TEXT, backed_up INTEGER NOT NULL, revision TEXT NOT NULL, created_at INTEGER NOT NULL);`)
  const store = new SqliteWebAuthnStore(drizzle(sqlite))
  const state = new MemoryAuthStateStore()
  const config = resolveWebAuthnConfig({
    rpId: 'auth.example.com',
    rpName: 'Test',
    origins: ['https://auth.example.com'],
    store: { create: () => ({ value: store }) },
    user: (sub) => ({ userName: sub, displayName: sub }),
    identity: identityResolver,
  })
  const policy = resolveMfaConfig({})
  const abort = new AbortController()
  const context = { logger: getLogger(['test']), signal: abort.signal }
  const identity = {
    authentication: undefined as AuthenticationFacts | undefined,
    sub: 'alice',
    ver: 7,
    jti: 'j',
    authTime: Math.floor(Date.now() / 1000),
    claims: { plan: 'reader' },
    roles: ['reader'],
    amr: ['pwd'],
  }
  const webauthn = new WebAuthnServiceImpl({
    config,
    webauthnStore: store,
    stateStore: state,
    policy,
    context,
    getCurrentIdentity: () => identity,
  })
  const credential = createCredential()
  const enrollment = await webauthn.beginEnrollment()
  await webauthn.confirmEnrollment(
    enrollment.challenge,
    credential.registration(enrollment.options),
  )
  const issue = vi.fn(async (input) => ({
    identity: { ...input, jti: 'issued', ver: input.ver ?? 0, claims: input.claims ?? {} },
    token: 'coordinator-test',
  }))
  const mfa = new MfaServiceImpl({
    config: policy,
    stateStore: state,
    sessionService: { signIn: issue },
    context,
    getCurrentIdentity: () => identity,
    factors: [
      {
        kind: 'webauthn',
        isEnabled: (sub) => webauthn.isEnabled(sub),
        findSubject: async (proof) =>
          proof.kind === 'webauthn'
            ? ((await store.findCredential(authenticationCredentialId(proof.response)))?.sub ??
              null)
            : null,
        identity: identityResolver,
        verifyProof: (flow, proof) =>
          webauthn.verifyProof(
            flow,
            (proof as { response: ReturnType<typeof credential.authentication> }).response,
          ),
      },
    ],
  })
  return { state, store, webauthn, credential, mfa, issue, identity, abort }
}

describe('WebAuthn signed protocol and shared MFA completion', () => {
  it('keeps protocol expectations stable when the application changes returned browser options', async () => {
    const f = await fixture()
    const login = await f.webauthn.beginLogin()
    const expected = structuredClone(login.options)
    login.options.challenge = 'application-mutated-options'
    expect((await f.webauthn.beginAuthentication(login.challenge)).challenge).toBe(
      expected.challenge,
    )
    await expect(
      f.mfa.complete(login.challenge, {
        kind: 'webauthn',
        response: f.credential.authentication(expected),
      }),
    ).resolves.toMatchObject({ identity: { sub: 'alice' } })
  })

  it('registers a real public key and verifies signed second-step and passwordless responses', async () => {
    const f = await fixture(async (sub) => ({
      sub,
      ver: 9,
      roles: ['member'],
      claims: { current: true },
    }))
    expect((await f.store.findCredential(f.credential.id))!.publicKey.length).toBeGreaterThan(60)
    const login = await f.mfa.beginLogin({ sub: 'alice', amr: ['pwd'] })
    if (login.status !== 'challenge') throw new Error('Expected an enrolled-account challenge')
    const [first, second] = await Promise.all([
      f.webauthn.beginAuthentication(login.challenge),
      f.webauthn.beginAuthentication(login.challenge),
    ])
    expect(second).toEqual(first)
    const session = await f.mfa.complete(login.challenge, {
      kind: 'webauthn',
      response: f.credential.authentication(first),
    })
    expect(session.identity.amr).toEqual(['pwd', 'pop'])
    expect(session.identity.authentication).toEqual({ method: 'webauthn', userVerified: true })
    await expect(
      f.mfa.complete(login.challenge, {
        kind: 'webauthn',
        response: f.credential.authentication(first),
      }),
    ).rejects.toThrow()
    const passwordless = await f.webauthn.beginLogin()
    const resolved = await f.mfa.complete(passwordless.challenge, {
      kind: 'webauthn',
      response: f.credential.authentication(passwordless.options, { counter: 2 }),
    })
    expect(resolved.identity).toMatchObject({
      sub: 'alice',
      ver: 9,
      roles: ['member'],
      claims: { current: true },
      amr: ['pop'],
    })
  })

  it.each([
    ['challenge', { challenge: 'unrelated' }],
    ['origin', { origin: 'https://wrong.example.com' }],
    ['RP', { rpId: 'wrong.example.com' }],
    ['signature', { corruptSignature: true }],
    ['user verification', { userVerified: false }],
  ])(
    'rejects a signed response with incorrect %s against a valid registration baseline',
    async (_name, overrides) => {
      const f = await fixture()
      const login = await f.webauthn.beginLogin()
      await expect(
        f.mfa.complete(login.challenge, {
          kind: 'webauthn',
          response: f.credential.authentication(login.options, overrides),
        }),
      ).rejects.toMatchObject({ code: 'invalid_code' })
      expect(f.issue).not.toHaveBeenCalled()
      expect((await f.store.findCredential(f.credential.id))!.counter).toBe(0)
    },
  )

  it('does not issue or reopen a consumed proof when account mapping fails or is cancelled', async () => {
    let resolve!: () => void
    const waiting = new Promise<void>((done) => {
      resolve = done
    })
    const f = await fixture(async (sub) => {
      await waiting
      return { sub }
    })
    const login = await f.webauthn.beginLogin()
    const completing = f.mfa.complete(login.challenge, {
      kind: 'webauthn',
      response: f.credential.authentication(login.options),
    })
    await vi.waitFor(async () =>
      expect((await f.store.findCredential(f.credential.id))!.counter).toBe(1),
    )
    f.abort.abort(new Error('cancelled mapping'))
    resolve()
    await expect(completing).rejects.toThrow('cancelled mapping')
    expect(f.issue).not.toHaveBeenCalled()
    expect(await f.state.read(login.challenge)).toBeNull()
    expect(await f.store.findCredential(f.credential.id)).not.toBeNull()
  })
  it.each(['reject', 'mismatch'] as const)(
    'does not issue a session after identity mapping %s',
    async (mode) => {
      const f = await fixture(async () => {
        if (mode === 'reject') throw new Error('account disabled')
        return { sub: 'someone-else' }
      })
      const login = await f.webauthn.beginLogin()
      await expect(
        f.mfa.complete(login.challenge, {
          kind: 'webauthn',
          response: f.credential.authentication(login.options),
        }),
      ).rejects.toThrow(mode === 'reject' ? 'account disabled' : 'different subject')
      expect(f.issue).not.toHaveBeenCalled()
      expect(await f.state.read(login.challenge)).toBeNull()
      expect(await f.store.findCredential(f.credential.id)).not.toBeNull()
    },
  )

  it('rejects a step-up after the active account changes without consuming its credential', async () => {
    const f = await fixture()
    const flow = await f.mfa.beginStepUp()
    const options = await f.webauthn.beginAuthentication(flow.challenge)
    f.identity.sub = 'another-account'
    await expect(
      f.mfa.complete(flow.challenge, {
        kind: 'webauthn',
        response: f.credential.authentication(options),
      }),
    ).rejects.toMatchObject({ code: 'step_up_required' })
    expect(f.issue).not.toHaveBeenCalled()
    expect((await f.store.findCredential(f.credential.id))!.counter).toBe(0)
  })
  it.each(
    ['passwordless', 'second-step'].flatMap((mode) =>
      [null, {}, { id: '' }].map((response) => ({ mode, response })),
    ),
  )('rejects a malformed $mode response before SQL lookup', async ({ mode, response }) => {
    const f = await fixture()
    const lookup = vi.spyOn(f.store, 'findCredential')
    let challenge: string
    if (mode === 'passwordless') challenge = (await f.webauthn.beginLogin()).challenge
    else {
      const login = await f.mfa.beginLogin({ sub: 'alice' })
      if (login.status !== 'challenge') throw new Error('Expected factor challenge')
      challenge = login.challenge
      await f.webauthn.beginAuthentication(challenge)
    }
    await expect(f.mfa.complete(challenge, { kind: 'webauthn', response })).rejects.toMatchObject({
      code: 'invalid_code',
    })
    expect(lookup).not.toHaveBeenCalled()
    expect(f.issue).not.toHaveBeenCalled()
    expect(await f.state.read(challenge)).toMatchObject({
      status: 'pending',
      attempts: mode === 'passwordless' ? 0 : 1,
    })
  })

  it('enforces credential management authentication, ownership and revision conflicts', async () => {
    const f = await fixture()
    await expect(f.webauthn.removeCredential(f.credential.id)).rejects.toMatchObject({
      code: 'step_up_required',
    })
    f.identity.authentication = { method: 'webauthn', userVerified: true }
    const original = (await f.store.findCredential(f.credential.id))!
    await f.store.insertCredential({
      ...original,
      credentialId: 'other-credential',
      sub: 'another-account',
    })
    await f.webauthn.removeCredential('other-credential')
    expect(await f.store.findCredential('other-credential')).not.toBeNull()
    const remove = vi.spyOn(f.store, 'removeCredential').mockResolvedValueOnce(false)
    await expect(f.webauthn.removeCredential(f.credential.id)).rejects.toMatchObject({
      code: 'conflict',
    })
    remove.mockRestore()
    await f.webauthn.removeCredential(f.credential.id)
    expect(await f.store.findCredential(f.credential.id)).toBeNull()
  })

  it('does not delete a credential when cancellation arrives during its lookup', async () => {
    const f = await fixture()
    f.identity.authentication = { method: 'webauthn', userVerified: true }
    const original = (await f.store.findCredential(f.credential.id))!
    const started = Promise.withResolvers<void>()
    const reading = Promise.withResolvers<typeof original>()
    const lookup = vi.spyOn(f.store, 'findCredential').mockImplementationOnce(() => {
      started.resolve()
      return reading.promise
    })
    const remove = vi.spyOn(f.store, 'removeCredential')
    const cancelled = new Error('request cancelled')
    const removing = f.webauthn.removeCredential(f.credential.id)
    const rejected = expect(removing).rejects.toBe(cancelled)
    await started.promise
    f.abort.abort(cancelled)
    reading.resolve(original)
    await rejected
    expect(remove).not.toHaveBeenCalled()
    lookup.mockRestore()
    expect(await f.store.findCredential(f.credential.id)).toEqual(original)
  })

  it.each(['different-user', ''])(
    'rejects a passwordless user handle that does not identify the stored owner',
    async (handle) => {
      const f = await fixture()
      const login = await f.webauthn.beginLogin()
      const response = f.credential.authentication(login.options)
      response.response.userHandle = Buffer.from(handle).toString('base64url')
      await expect(
        f.mfa.complete(login.challenge, { kind: 'webauthn', response }),
      ).rejects.toMatchObject({ code: 'invalid_code' })
      expect(f.issue).not.toHaveBeenCalled()
      expect((await f.store.findCredential(f.credential.id))!.counter).toBe(0)
    },
  )
})
