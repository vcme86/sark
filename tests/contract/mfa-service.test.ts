import { getLogger } from '@logtape/logtape'
import { ScureBase32Plugin } from '@otplib/plugin-base32-scure'
import { WebCryptoPlugin } from '@otplib/plugin-crypto-web'
import { TOTP } from '@otplib/totp'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AuthError } from '../../src/services/auth/error'
import type { FactorProof, FactorVerifier } from '../../src/services/auth/factor'
import { resolveMfaConfig } from '../../src/services/auth/mfa/config'
import { MfaService } from '../../src/services/auth/mfa/service'
import {
  generateRecoveryCodes,
  hashRecoveryCode,
  verifyRecoveryCode,
} from '../../src/services/auth/recovery/service'
import type { RecoveryCodeSet, RecoveryStore } from '../../src/services/auth/recovery/types'
import type { SessionOptions, SignInInput } from '../../src/services/auth/session/types'
import { MemoryAuthStateStore } from '../../src/services/auth/state/memory'
import { resolveTotpConfig } from '../../src/services/auth/totp/config'
import { encryptTotpSecret } from '../../src/services/auth/totp/crypto'
import { TotpService } from '../../src/services/auth/totp/service'
import type { TotpRecord, TotpStore } from '../../src/services/auth/totp/types'

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('MFA Complete Service State Machine Contract', () => {
  const stateStore = new MemoryAuthStateStore()

  // In-memory RecoveryStore
  const recoveryRecords = new Map<string, { revision: string; hashes: readonly string[] }>()
  const recoveryStore: RecoveryStore = {
    async read(sub) {
      return recoveryRecords.get(sub) ?? null
    },
    async commit(sub, expectedRevision, next) {
      const existing = recoveryRecords.get(sub)
      if (expectedRevision === null) {
        if (existing) return false
        if (next) recoveryRecords.set(sub, next)
        return true
      }
      if (!existing || existing.revision !== expectedRevision) return false
      if (next) recoveryRecords.set(sub, next)
      else recoveryRecords.delete(sub)
      return true
    },
  }

  // In-memory TotpStore
  const totpRecords = new Map<string, TotpRecord>()
  const totpStore: TotpStore = {
    async read(sub) {
      return totpRecords.get(sub) ?? null
    },
    async commit(sub, expectedRevision, next) {
      const existing = totpRecords.get(sub)
      if (expectedRevision === null) {
        if (existing) return false
        if (next) totpRecords.set(sub, next)
        return true
      }
      if (!existing || existing.revision !== expectedRevision) return false
      if (next) totpRecords.set(sub, next)
      else totpRecords.delete(sub)
      return true
    },
  }

  const currentTotpKey = {
    id: 'totp-k1',
    key: new Uint8Array(32).fill(0x11),
  }

  const totpConfig = resolveTotpConfig({
    issuer: 'TestService',
    keys: { current: currentTotpKey, retired: [] },
    algorithm: 'SHA1' as const,
    digits: 6,
    period: 30,
    epochTolerance: 30,
    store: { create: () => ({ value: totpStore }) },
  })

  const otplib = new TOTP({
    crypto: new WebCryptoPlugin(),
    base32: new ScureBase32Plugin(),
    algorithm: 'sha1',
    digits: 6,
    period: 30,
  })

  const rawSecret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'

  const mockSessionService = {
    async signIn(input: SignInInput, _options?: SessionOptions) {
      return {
        identity: {
          sub: input.sub,
          ver: input.ver ?? 0,
          jti: 'mock-jti-123',
          amr: input.amr,
          authTime: input.authTime,
          roles: input.roles,
          auth: input.auth,
          claims: input.claims ?? {},
        },
        token: `mock.jwt.token.${input.sub}`,
      }
    },
  }

  it('handles login policies correctly', async () => {
    const totpService = new TotpService({
      context: { logger: getLogger(['test']) },
      config: totpConfig,
      totpStore,
      stateStore,
      policy: resolveMfaConfig({}),
      getCurrentIdentity: () => ({ sub: 'user_unenrolled', ver: 0, jti: 'j1', claims: {} }),
    })

    const totpFactor: FactorVerifier = {
      kind: 'totp',
      isEnabled: (sub) => totpService.isEnabled(sub),
      verifyProof: async (flow, proof) => {
        const res = await totpService.verifyProof(flow, proof.kind === 'totp' ? proof.code : '')
        return { verified: res.verified }
      },
    }

    const mfaService = new MfaService({
      context: { logger: getLogger(['test']) },
      config: resolveMfaConfig({ signIn: 'if-enrolled' }),
      stateStore,
      sessionService: mockSessionService,
      recoveryStore,
      factors: [totpFactor],
    })

    // Unenrolled user with 'if-enrolled' logs in immediately
    const res1 = await mfaService.beginSignIn({ sub: 'user_unenrolled' })
    expect(res1.status).toBe('authenticated')

    // Unenrolled user with 'required' policy throws factor_unavailable
    const mfaRequiredService = new MfaService({
      context: { logger: getLogger(['test']) },
      config: resolveMfaConfig({ signIn: 'required' }),
      stateStore,
      sessionService: mockSessionService,
      recoveryStore,
      factors: [totpFactor],
    })

    await expect(mfaRequiredService.beginSignIn({ sub: 'user_unenrolled' })).rejects.toThrow(
      AuthError,
    )
  })

  it('completes TOTP flow and rejects replays and concurrent attempts', async () => {
    const sub = 'user_with_totp'
    const factorId = 'factor-totp-1'

    const encryptedBytes = await encryptTotpSecret(rawSecret, currentTotpKey, sub, factorId)

    const record: TotpRecord = {
      factorId,
      secret: encryptedBytes,
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      lastStep: 0,
      revision: 'rev-totp-1',
      enabledAt: Date.now(),
    }
    await totpStore.commit(sub, null, record, { logger: getLogger(['test']) })

    const totpService = new TotpService({
      context: { logger: getLogger(['test']) },
      config: totpConfig,
      totpStore,
      stateStore,
      policy: resolveMfaConfig({}),
      getCurrentIdentity: () => ({ sub, ver: 0, jti: 'j1', claims: {} }),
    })

    const totpFactor: FactorVerifier = {
      kind: 'totp',
      isEnabled: (s) => totpService.isEnabled(s),
      verifyProof: async (flow, proof) => {
        const res = await totpService.verifyProof(flow, proof.kind === 'totp' ? proof.code : '')
        return { verified: res.verified }
      },
    }

    const mfaService = new MfaService({
      context: { logger: getLogger(['test']) },
      config: resolveMfaConfig({ signIn: 'if-enrolled' }),
      stateStore,
      sessionService: mockSessionService,
      factors: [totpFactor],
    })

    const loginRes = await mfaService.beginSignIn({ sub })
    expect(loginRes.status).toBe('challenge')
    if (loginRes.status !== 'challenge') return

    const challenge = loginRes.challenge
    const validCode = await otplib.generate({ secret: rawSecret })

    // Wrong code fails and leaves challenge available for retry
    await expect(mfaService.complete(challenge, { kind: 'totp', code: '000000' })).rejects.toThrow(
      AuthError,
    )

    // Valid code succeeds and issues session
    const session = await mfaService.complete(challenge, {
      kind: 'totp',
      code: validCode,
    })
    expect(session.identity.sub).toBe(sub)
    expect(session.identity.amr).toContain('otp')
    expect(session.identity.auth).toEqual({ method: 'totp' })

    // Replay on already-consumed challenge throws error
    await expect(mfaService.complete(challenge, { kind: 'totp', code: validCode })).rejects.toThrow(
      AuthError,
    )

    // Anti-replay on new challenge with the same time-step code fails!
    const loginRes2 = await mfaService.beginSignIn({ sub })
    if (loginRes2.status === 'challenge') {
      await expect(
        mfaService.complete(loginRes2.challenge, { kind: 'totp', code: validCode }),
      ).rejects.toThrow(AuthError)
    }
  })

  it.each(['', '12345', '1234567', '123 456', '123-456', '12345a', undefined, null, 123])(
    'keeps malformed TOTP code %j retryable for login and enrollment',
    async (invalidCode) => {
      const context = { logger: getLogger(['test']) }
      const sub = crypto.randomUUID()
      const factorId = crypto.randomUUID()
      const state = new MemoryAuthStateStore()
      const commit = vi.spyOn(totpStore, 'commit')
      await totpStore.commit(
        sub,
        null,
        {
          factorId,
          secret: await encryptTotpSecret(rawSecret, currentTotpKey, sub, factorId),
          algorithm: 'SHA1',
          digits: 6,
          period: 30,
          lastStep: 0,
          revision: crypto.randomUUID(),
          enabledAt: Date.now(),
        },
        context,
      )
      commit.mockClear()
      const factor = new TotpService({
        config: totpConfig,
        totpStore,
        stateStore: state,
        policy: resolveMfaConfig({}),
        context,
        getCurrentIdentity: () => ({
          sub: sub + '-enroll',
          ver: 0,
          jti: 'j',
          claims: {},
          authTime: Math.floor(Date.now() / 1000),
        }),
      })
      const sessionService = { signIn: vi.fn(mockSessionService.signIn) }
      const service = new MfaService({
        config: resolveMfaConfig({}),
        stateStore: state,
        sessionService,
        context,
        factors: [
          {
            kind: 'totp',
            isEnabled: (subject) => factor.isEnabled(subject),
            verifyProof: (flow, proof) =>
              factor.verifyProof(flow, (proof as { code: string }).code),
          },
        ],
      })
      const login = await service.beginSignIn({ sub })
      if (login.status !== 'challenge') throw new Error('Expected a TOTP challenge')
      await expect(
        service.complete(login.challenge, { kind: 'totp', code: invalidCode } as FactorProof),
      ).rejects.toMatchObject({ code: 'invalid_code' })
      expect(await state.read(login.challenge)).toMatchObject({ status: 'pending', attempts: 1 })
      expect(commit).not.toHaveBeenCalled()
      expect(sessionService.signIn).not.toHaveBeenCalled()
      await service.complete(login.challenge, {
        kind: 'totp',
        code: await otplib.generate({ secret: rawSecret }),
      })
      expect(await state.read(login.challenge)).toBeNull()
      const enrollment = await factor.beginEnrollment()
      await expect(
        factor.confirmEnrollment(enrollment.challenge, invalidCode as string),
      ).rejects.toMatchObject({ code: 'invalid_code' })
      expect(await state.read(enrollment.challenge)).toMatchObject({
        status: 'pending',
        attempts: 1,
      })
      const secret = new URL(enrollment.uri).searchParams.get('secret')!
      await expect(
        factor.confirmEnrollment(enrollment.challenge, await otplib.generate({ secret })),
      ).resolves.toEqual({ enabled: true })
      expect(await state.read(enrollment.challenge)).toBeNull()
      commit.mockRestore()
    },
  )

  it.each([null, undefined, {}, { kind: 'unsupported' }])(
    'rejects malformed proof envelope %j before claiming',
    async (proof) => {
      const state = new MemoryAuthStateStore()
      const verifyProof = vi.fn()
      const service = new MfaService({
        context: { logger: getLogger(['test']) },
        config: resolveMfaConfig({}),
        stateStore: state,
        sessionService: mockSessionService,
        factors: [{ kind: 'totp', isEnabled: async () => true, verifyProof }],
      })
      const login = await service.beginSignIn({ sub: 'alice' })
      if (login.status !== 'challenge') throw new Error('Expected a challenge')
      await expect(service.complete(login.challenge, proof as FactorProof)).rejects.toMatchObject({
        code: 'invalid_code',
      })
      expect(await state.read(login.challenge)).toMatchObject({ status: 'pending', attempts: 0 })
      expect(verifyProof).not.toHaveBeenCalled()
    },
  )

  it.each(['', undefined, null, 123])(
    'keeps malformed recovery code %j retryable',
    async (code) => {
      const sub = crypto.randomUUID()
      const state = new MemoryAuthStateStore()
      const [validCode] = generateRecoveryCodes(1)
      await recoveryStore.commit(sub, null, {
        revision: 'initial',
        hashes: [await hashRecoveryCode(validCode)],
      })
      const service = new MfaService({
        context: { logger: getLogger(['test']) },
        config: resolveMfaConfig({}),
        stateStore: state,
        sessionService: mockSessionService,
        recoveryStore,
        factors: [],
      })
      const login = await service.beginSignIn({ sub })
      if (login.status !== 'challenge') throw new Error('Expected a recovery challenge')
      await expect(
        service.complete(login.challenge, { kind: 'recovery', code } as FactorProof),
      ).rejects.toMatchObject({ code: 'invalid_code' })
      expect(await state.read(login.challenge)).toMatchObject({ status: 'pending', attempts: 1 })
      expect((await recoveryStore.read(sub))?.hashes).toHaveLength(1)
      await expect(
        service.complete(login.challenge, { kind: 'recovery', code: validCode }),
      ).resolves.toMatchObject({ identity: { sub, auth: { method: 'recovery' } } })
    },
  )

  it.each(['skip', 'if-enrolled'] as const)(
    'preserves server-verified first-step facts under %s policy',
    async (signIn) => {
      const service = new MfaService({
        context: { logger: getLogger(['test']) },
        config: resolveMfaConfig({ signIn }),
        stateStore: new MemoryAuthStateStore(),
        sessionService: mockSessionService,
        factors: [],
      })
      const input: SignInInput = {
        sub: 'alice',
        amr: ['pop'],
        authTime: 1234,
        auth: { method: 'webauthn', userVerified: true },
      }
      const result = await service.beginSignIn(input)
      if (result.status !== 'authenticated') throw new Error('Expected first-step authentication')
      expect(result.session.identity).toMatchObject(input)
    },
  )

  it('preserves session attributes across step-up authentication', async () => {
    const sub = 'alice'
    const factorId = 'fac-alice'
    const encryptedBytes = await encryptTotpSecret(rawSecret, currentTotpKey, sub, factorId)

    await totpStore.commit(
      sub,
      null,
      {
        factorId,
        secret: encryptedBytes,
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        lastStep: 0,
        revision: 'rev-alice-1',
        enabledAt: Date.now(),
      },
      { logger: getLogger(['test']) },
    )

    const totpService = new TotpService({
      context: { logger: getLogger(['test']) },
      config: totpConfig,
      totpStore,
      stateStore,
      policy: resolveMfaConfig({}),
    })

    const totpFactor: FactorVerifier = {
      kind: 'totp',
      isEnabled: (s) => totpService.isEnabled(s),
      verifyProof: async (flow, proof) => {
        const res = await totpService.verifyProof(flow, proof.kind === 'totp' ? proof.code : '')
        return { verified: res.verified }
      },
    }

    const currentSession = {
      sub: 'alice',
      ver: 3,
      jti: 'j_alice',
      roles: ['admin'],
      claims: { orgId: 'org_42' },
      amr: ['pwd'],
      authTime: Math.floor(Date.now() / 1000),
    }

    const mfaService = new MfaService({
      context: { logger: getLogger(['test']) },
      config: resolveMfaConfig(),
      stateStore,
      sessionService: mockSessionService,
      factors: [totpFactor],
      getCurrentIdentity: () => currentSession,
    })

    // Alice begins step-up from active session
    const stepUp = await mfaService.beginStepUp()
    const validCode = await otplib.generate({ secret: rawSecret })

    const session = await mfaService.complete(stepUp.challenge, { kind: 'totp', code: validCode })
    expect(session.identity.sub).toBe('alice')
    expect(session.identity.ver).toBe(3)
    expect(session.identity.roles).toEqual(['admin'])
    expect(session.identity.claims).toEqual({ orgId: 'org_42' })
    expect(session.identity.amr).toEqual(['pwd', 'otp'])
    expect(session.identity.auth).toEqual({ method: 'totp' })
  })

  it('completes Recovery code flow and records otp AMR', async () => {
    const sub = 'user_with_recovery'
    const codes = generateRecoveryCodes(3)
    const hashes = await Promise.all(codes.map((c: string) => hashRecoveryCode(c)))
    await recoveryStore.commit(sub, null, { revision: 'rev-rec', hashes })

    const mfaService = new MfaService({
      context: { logger: getLogger(['test']) },
      config: resolveMfaConfig({
        signIn: 'if-enrolled',
        recovery: { store: { create: () => ({ value: recoveryStore }) } },
      }),
      stateStore,
      sessionService: mockSessionService,
      recoveryStore,
      factors: [],
    })

    const loginRes = await mfaService.beginSignIn({ sub })
    expect(loginRes.status).toBe('challenge')
    if (loginRes.status !== 'challenge') return

    const session = await mfaService.complete(loginRes.challenge, {
      kind: 'recovery',
      code: codes[0],
    })
    expect(session.identity.sub).toBe(sub)
    expect(session.identity.amr).toContain('otp')
    expect(session.identity.auth).toEqual({ method: 'recovery' })

    // Code is now consumed, second attempt with consumed code fails
    const loginRes2 = await mfaService.beginSignIn({ sub })
    if (loginRes2.status === 'challenge') {
      await expect(
        mfaService.complete(loginRes2.challenge, { kind: 'recovery', code: codes[0] }),
      ).rejects.toThrow(AuthError)
    }
  })
  it.each(['cancelled', 'expired'] as const)(
    'does not consume a recovery code when the flow becomes %s during a read',
    async (ending) => {
      vi.useFakeTimers({ now: 1_800_000_000_000 })
      const abort = new AbortController()
      const cancelled = new Error('request cancelled')
      const context = { logger: getLogger(['test']), signal: abort.signal }
      const state = new MemoryAuthStateStore()
      const [code] = generateRecoveryCodes(1)
      const record: RecoveryCodeSet = { revision: 'r', hashes: [await hashRecoveryCode(code)] }
      const store = { read: vi.fn(async () => record), commit: vi.fn(async () => true) }
      const signIn = vi.fn(mockSessionService.signIn)
      const service = new MfaService({
        context,
        config: resolveMfaConfig({ challenge: { ttl: 1000 } }),
        stateStore: state,
        sessionService: { signIn },
        recoveryStore: store,
        factors: [],
      })
      const login = await service.beginSignIn({ sub: 'alice' })
      if (login.status !== 'challenge') throw new Error('Expected a recovery challenge')
      const started = Promise.withResolvers<void>()
      const reading = Promise.withResolvers<RecoveryCodeSet>()
      store.read.mockImplementationOnce(() => {
        started.resolve()
        return reading.promise
      })
      const completion = service.complete(login.challenge, { kind: 'recovery', code })
      const rejected =
        ending === 'cancelled'
          ? expect(completion).rejects.toBe(cancelled)
          : expect(completion).rejects.toMatchObject({ code: 'challenge_invalid' })
      await started.promise
      if (ending === 'cancelled') abort.abort(cancelled)
      else vi.advanceTimersByTime(1000)
      reading.resolve(record)
      await rejected
      expect(store.commit).not.toHaveBeenCalled()
      expect(signIn).not.toHaveBeenCalled()
      expect(await verifyRecoveryCode(code, record.hashes)).toMatchObject({ valid: true })
    },
  )

  it('does not replace recovery codes when cancellation arrives during the previous-set read', async () => {
    const abort = new AbortController()
    const cancelled = new Error('request cancelled')
    const [code] = generateRecoveryCodes(1)
    const previous = { revision: 'r', hashes: [await hashRecoveryCode(code)] }
    const started = Promise.withResolvers<void>()
    const reading = Promise.withResolvers<RecoveryCodeSet>()
    const store = {
      read: async () => {
        started.resolve()
        return reading.promise
      },
      commit: vi.fn(async () => true),
    }
    const service = new MfaService({
      context: { logger: getLogger(['test']), signal: abort.signal },
      config: resolveMfaConfig({ recovery: { store: { create: () => ({ value: store }) } } }),
      stateStore: new MemoryAuthStateStore(),
      sessionService: mockSessionService,
      recoveryStore: store,
      factors: [],
      getCurrentIdentity: () => ({
        sub: 'alice',
        ver: 0,
        jti: 'j',
        claims: {},
        authTime: Math.floor(Date.now() / 1000),
        auth: { method: 'totp' },
      }),
    })
    const replacing = service.regenerateRecoveryCodes()
    const rejected = expect(replacing).rejects.toBe(cancelled)
    await started.promise
    abort.abort(cancelled)
    reading.resolve(previous)
    await rejected
    expect(store.commit).not.toHaveBeenCalled()
    expect(await verifyRecoveryCode(code, previous.hashes)).toMatchObject({ valid: true })
  })

  it.each(['cancelled', 'expired'] as const)(
    'does not advance TOTP replay state when the flow becomes %s during a read',
    async (ending) => {
      vi.useFakeTimers({ now: 1_800_000_000_000 })
      const abort = new AbortController()
      const cancelled = new Error('request cancelled')
      const context = { logger: getLogger(['test']), signal: abort.signal }
      const state = new MemoryAuthStateStore()
      const sub = crypto.randomUUID()
      const factorId = crypto.randomUUID()
      const record: TotpRecord = {
        factorId,
        secret: await encryptTotpSecret(rawSecret, currentTotpKey, sub, factorId),
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
        lastStep: 0,
        revision: 'r',
        enabledAt: Date.now(),
      }
      const store = { read: vi.fn(async () => record), commit: vi.fn(async () => true) }
      const totp = new TotpService({
        config: totpConfig,
        totpStore: store,
        stateStore: state,
        policy: resolveMfaConfig({}),
        context,
      })
      const signIn = vi.fn(mockSessionService.signIn)
      const service = new MfaService({
        context,
        config: resolveMfaConfig({ challenge: { ttl: 1000 } }),
        stateStore: state,
        sessionService: { signIn },
        factors: [
          {
            kind: 'totp',
            isEnabled: (value) => totp.isEnabled(value),
            verifyProof: (flow, proof, request) =>
              totp.verifyProof(flow, (proof as { code: string }).code, request),
          },
        ],
      })
      const login = await service.beginSignIn({ sub })
      if (login.status !== 'challenge') throw new Error('Expected a TOTP challenge')
      const code = await otplib.generate({ secret: rawSecret })
      const started = Promise.withResolvers<void>()
      const reading = Promise.withResolvers<TotpRecord>()
      store.read.mockImplementationOnce(() => {
        started.resolve()
        return reading.promise
      })
      const completion = service.complete(login.challenge, { kind: 'totp', code })
      const rejected =
        ending === 'cancelled'
          ? expect(completion).rejects.toBe(cancelled)
          : expect(completion).rejects.toMatchObject({ code: 'challenge_invalid' })
      await started.promise
      if (ending === 'cancelled') abort.abort(cancelled)
      else vi.advanceTimersByTime(1000)
      reading.resolve(record)
      await rejected
      expect(store.commit).not.toHaveBeenCalled()
      expect(signIn).not.toHaveBeenCalled()
      expect(record.lastStep).toBe(0)
    },
  )

  it('does not disable TOTP when cancellation arrives during the factor read', async () => {
    const sub = crypto.randomUUID()
    const factorId = crypto.randomUUID()
    const record: TotpRecord = {
      factorId,
      secret: await encryptTotpSecret(rawSecret, currentTotpKey, sub, factorId),
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      lastStep: 0,
      revision: 'r',
      enabledAt: Date.now(),
    }
    const started = Promise.withResolvers<void>()
    const reading = Promise.withResolvers<TotpRecord>()
    const store = {
      read: async () => {
        started.resolve()
        return reading.promise
      },
      commit: vi.fn(async () => true),
    }
    const abort = new AbortController()
    const cancelled = new Error('request cancelled')
    const service = new TotpService({
      config: totpConfig,
      totpStore: store,
      stateStore: new MemoryAuthStateStore(),
      policy: resolveMfaConfig({}),
      context: { logger: getLogger(['test']), signal: abort.signal },
      getCurrentIdentity: () => ({
        sub,
        ver: 0,
        jti: 'j',
        claims: {},
        authTime: Math.floor(Date.now() / 1000),
        auth: { method: 'totp' },
      }),
    })
    const disabling = service.disable()
    const rejected = expect(disabling).rejects.toBe(cancelled)
    await started.promise
    abort.abort(cancelled)
    reading.resolve(record)
    await rejected
    expect(store.commit).not.toHaveBeenCalled()
  })

  it('uses enrollment parameters captured before a configuration change and rejects stale enrollment versions', async () => {
    const sub = 'enrollment-snapshot'
    const identity = { sub, ver: 0, jti: 'j', claims: {}, authTime: Math.floor(Date.now() / 1000) }
    const context = { logger: getLogger(['test']) }
    const policy = resolveMfaConfig({})
    const before = new TotpService({
      config: resolveTotpConfig({ ...totpConfig, algorithm: 'SHA256', digits: 8, period: 60 }),
      totpStore,
      stateStore,
      policy,
      context,
      getCurrentIdentity: () => identity,
    })
    const enrollment = await before.beginEnrollment()
    const stale = await before.beginEnrollment()
    const secret = new URL(enrollment.uri).searchParams.get('secret')!
    const token = await new TOTP({
      crypto: new WebCryptoPlugin(),
      base32: new ScureBase32Plugin(),
      algorithm: 'sha256',
      digits: 8,
      period: 60,
    }).generate({ secret })
    const after = new TotpService({
      config: totpConfig,
      totpStore,
      stateStore,
      policy,
      context,
      getCurrentIdentity: () => identity,
    })
    expect(await after.confirmEnrollment(enrollment.challenge, token)).toEqual({ enabled: true })
    expect(await totpStore.read(sub, context)).toMatchObject({
      algorithm: 'SHA256',
      digits: 8,
      period: 60,
    })
    const staleCode = await new TOTP({
      crypto: new WebCryptoPlugin(),
      base32: new ScureBase32Plugin(),
      algorithm: 'sha256',
      digits: 8,
      period: 60,
    }).generate({ secret: new URL(stale.uri).searchParams.get('secret')! })
    await expect(after.confirmEnrollment(stale.challenge, staleCode)).rejects.toMatchObject({
      code: 'conflict',
    })
    await expect(after.disable()).rejects.toMatchObject({ code: 'step_up_required' })
    const authorized = new TotpService({
      config: totpConfig,
      totpStore,
      stateStore,
      policy,
      context,
      getCurrentIdentity: () => ({ ...identity, auth: { method: 'totp' } }),
    })
    await authorized.disable()
    expect(await totpStore.read(sub, context)).toBeNull()
  })

  it('does not report binding success when the claimed flow cannot be consumed', async () => {
    const state = new MemoryAuthStateStore()
    vi.spyOn(state, 'consume').mockResolvedValue(false)
    const marked = vi.fn()
    const service = new TotpService({
      config: totpConfig,
      totpStore,
      stateStore: state,
      policy: resolveMfaConfig({}),
      context: { logger: getLogger(['test']) },
      getCurrentIdentity: () => ({
        sub: 'consume-failure',
        ver: 0,
        jti: 'j',
        claims: {},
        authTime: Math.floor(Date.now() / 1000),
      }),
      markFactorEnrolledInRequest: marked,
    })
    const enrollment = await service.beginEnrollment()
    const secret = new URL(enrollment.uri).searchParams.get('secret')!
    await expect(
      service.confirmEnrollment(enrollment.challenge, await otplib.generate({ secret })),
    ).rejects.toMatchObject({ code: 'challenge_invalid' })
    expect(marked).not.toHaveBeenCalled()
    expect(await state.read(enrollment.challenge)).toMatchObject({ status: 'verifying' })
  })
  it('rejects invalid callback policies and issuance claims before creating authentication state', async () => {
    const state = new MemoryAuthStateStore()
    const create = vi.spyOn(state, 'create')
    const issue = vi.spyOn(mockSessionService, 'signIn')
    try {
      const invalidPolicy: unknown = 'bogus'
      const invalid = new MfaService({
        config: resolveMfaConfig({ signIn: () => invalidPolicy as 'required' }),
        stateStore: state,
        sessionService: mockSessionService,
        factors: [],
        context: { logger: getLogger(['test']) },
      })
      await expect(invalid.beginSignIn({ sub: 'alice' })).rejects.toThrow('MFA sign-in policy')
      const service = new MfaService({
        config: resolveMfaConfig({}),
        stateStore: state,
        sessionService: mockSessionService,
        factors: [
          {
            kind: 'totp',
            isEnabled: async () => true,
            verifyProof: async () => ({ verified: true }),
          },
        ],
        context: { logger: getLogger(['test']) },
      })
      await expect(service.beginSignIn({ sub: 'alice', claims: { amr: ['otp'] } })).rejects.toThrow(
        'reserved',
      )
      expect(create).not.toHaveBeenCalled()
      expect(issue).not.toHaveBeenCalled()
    } finally {
      issue.mockRestore()
    }
  })
  it('authorizes recovery replacement from real same-request enrollment and conditionally replaces concurrent sets', async () => {
    const sub = 'recovery-management'
    const context = { logger: getLogger(['test']) }
    let auth: { method: 'totp' } | undefined
    const getIdentity = () => ({
      sub,
      ver: 0,
      jti: 'j',
      claims: {},
      authTime: Math.floor(Date.now() / 1000),
      auth,
    })
    const enrolled = new Set<string>()
    const config = resolveMfaConfig({
      recovery: { store: { create: () => ({ value: recoveryStore }) }, count: 2 },
    })
    const base = {
      stateStore,
      sessionService: mockSessionService,
      context,
      getCurrentIdentity: getIdentity,
      factors: [],
    }
    const mfa = new MfaService({
      ...base,
      config,
      recoveryStore,
      wasFactorEnrolledInRequest: (value) => enrolled.has(value),
    })
    await expect(mfa.regenerateRecoveryCodes()).rejects.toMatchObject({ code: 'step_up_required' })
    await expect(
      new MfaService({ ...base, config: resolveMfaConfig({}) }).regenerateRecoveryCodes(),
    ).rejects.toMatchObject({ code: 'factor_missing' })
    const totp = new TotpService({
      config: totpConfig,
      totpStore,
      stateStore,
      policy: config,
      context,
      getCurrentIdentity: getIdentity,
      markFactorEnrolledInRequest: (value) => enrolled.add(value),
    })
    const pending = await totp.beginEnrollment()
    const secret = new URL(pending.uri).searchParams.get('secret')!
    await totp.confirmEnrollment(pending.challenge, await otplib.generate({ secret }))
    const first = await mfa.regenerateRecoveryCodes()
    expect(first.recoveryCodes).toHaveLength(2)
    enrolled.clear()
    await expect(mfa.regenerateRecoveryCodes()).rejects.toMatchObject({ code: 'step_up_required' })
    auth = { method: 'totp' }
    const second = await mfa.regenerateRecoveryCodes()
    expect(second.recoveryCodes).not.toEqual(first.recoveryCodes)
    expect(
      await verifyRecoveryCode(first.recoveryCodes[0], (await recoveryStore.read(sub))!.hashes),
    ).toEqual({ valid: false })
    const bothRead = Promise.withResolvers<void>()
    let reads = 0
    const concurrent: RecoveryStore = {
      async read(value) {
        const snapshot = await recoveryStore.read(value)
        if (++reads === 2) bothRead.resolve()
        await bothRead.promise
        return snapshot
      },
      commit: recoveryStore.commit,
    }
    const replacing = new MfaService({ ...base, config, recoveryStore: concurrent })
    const results = await Promise.allSettled([
      replacing.regenerateRecoveryCodes(),
      replacing.regenerateRecoveryCodes(),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'conflict' },
    })
  })
})
