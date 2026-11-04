import { describe, expect, it } from 'vitest'

import { sqlRecovery } from '../../src/entries/auth/recovery-sqlite'
import { sqlTotp } from '../../src/entries/auth/totp-sqlite'
import { sqlWebAuthn } from '../../src/entries/auth/webauthn-sqlite'
import { resolveMfaConfig } from '../../src/features/auth/mfa/config'
import type { MfaConfig } from '../../src/features/auth/mfa/types'
import { resolveTotpConfig } from '../../src/features/auth/totp/config'
import { resolveWebAuthnConfig } from '../../src/features/auth/webauthn/config'
import { defineDatabase } from '../../src/features/db/sqlite'

describe('MFA configuration', () => {
  it('applies defaults when empty configuration object is passed', () => {
    const resolved = resolveMfaConfig({})
    expect(resolved.signIn).toBe('if-enrolled')
    expect(resolved.challenge.ttl).toBe(300_000)
    expect(resolved.challenge.maxAttempts).toBe(5)
    expect(resolved.accountLimit.window).toBe(600_000)
    expect(resolved.accountLimit.maxAttempts).toBe(10)
    expect(resolved.recentAuthMaxAge).toBe(300_000)
    expect(resolved.recovery).toBeUndefined()
  })

  it('rejects invalid numbers for challenge and accountLimit', () => {
    expect(() => resolveMfaConfig({ challenge: { ttl: -10 } })).toThrow(/ttl/)
    expect(() => resolveMfaConfig({ challenge: { maxAttempts: 0 } })).toThrow(/maxAttempts/)
    expect(() => resolveMfaConfig({ accountLimit: { window: -10 } })).toThrow(/window/)
    expect(() => resolveMfaConfig({ accountLimit: { maxAttempts: 0 } })).toThrow(/maxAttempts/)
  })

  it.each([{}, { create: true }, null])(
    'rejects invalid state and recovery stores %j during configuration',
    (store) => {
      expect(() => resolveMfaConfig({ state: store } as unknown as MfaConfig)).toThrow(
        'MFA state requires a store declaration',
      )
      expect(() => resolveMfaConfig({ recovery: { store } } as unknown as MfaConfig)).toThrow(
        'MFA recovery requires a store declaration',
      )
    },
  )

  it('rejects recovery without its required store', () => {
    expect(() => resolveMfaConfig({ recovery: {} } as unknown as MfaConfig)).toThrow(
      'MFA recovery requires a store declaration',
    )
  })

  it('resolves recovery settings with store', () => {
    const mockStore = sqlRecovery({ database: defineDatabase({ filename: ':memory:' }) })
    const resolved = resolveMfaConfig({ recovery: { store: mockStore, count: 8 } })
    expect(resolved.recovery?.count).toBe(8)
    expect(resolved.recovery?.store).toBe(mockStore)
  })
})

describe('TOTP configuration', () => {
  const validKey = new Uint8Array(32).fill(7)
  const mockStore = sqlTotp({ database: defineDatabase({ filename: ':memory:' }) })

  it('resolves valid configuration with standard defaults', () => {
    const resolved = resolveTotpConfig({
      issuer: 'TestApp',
      keys: {
        current: { id: 'k1', key: validKey },
      },
      store: mockStore,
    })
    expect(resolved.issuer).toBe('TestApp')
    expect(resolved.algorithm).toBe('SHA1')
    expect(resolved.digits).toBe(6)
    expect(resolved.period).toBe(30)
    expect(resolved.epochTolerance).toBe(30)
    expect(resolved.keys.retired).toEqual([])
  })

  it('rejects keys that are not 32 bytes', () => {
    expect(() =>
      resolveTotpConfig({
        issuer: 'TestApp',
        keys: {
          current: { id: 'k1', key: new Uint8Array(16) },
        },
        store: mockStore,
      }),
    ).toThrow(/32 bytes/)
  })

  it('rejects fractional time steps', () => {
    expect(() =>
      resolveTotpConfig({
        issuer: 'Test',
        keys: { current: { id: 'key', key: validKey } },
        store: mockStore,
        period: 0.5,
      }),
    ).toThrow('positive integer')
  })

  it('rejects missing or empty issuer', () => {
    expect(() =>
      resolveTotpConfig({
        issuer: '',
        keys: { current: { id: 'k1', key: validKey } },
        store: mockStore,
      }),
    ).toThrow(/issuer/)
  })
})

const userResolver = (sub: string) => ({ userName: sub, displayName: sub })

describe('WebAuthn configuration', () => {
  const mockStore = sqlWebAuthn({ database: defineDatabase({ filename: ':memory:' }) })

  it('resolves valid webauthn configuration', () => {
    const resolved = resolveWebAuthnConfig({
      rpId: 'auth.example.com',
      rpName: 'Example App',
      origins: ['https://auth.example.com'],
      store: mockStore,
      user: userResolver,
    })
    expect(resolved.rpId).toBe('auth.example.com')
    expect(resolved.rpName).toBe('Example App')
    expect(resolved.origins).toEqual(['https://auth.example.com'])
    expect(resolved.userVerification).toBe('required')
  })

  it('rejects fractional browser timeouts', () => {
    expect(() =>
      resolveWebAuthnConfig({
        rpId: 'example.com',
        rpName: 'Test',
        origins: ['https://example.com'],
        store: mockStore,
        user: userResolver,
        timeout: 0.5,
      }),
    ).toThrow('positive integer')
  })

  it('rejects invalid or empty origins', () => {
    expect(() =>
      resolveWebAuthnConfig({
        rpId: 'auth.example.com',
        rpName: 'Example App',
        origins: [],
        store: mockStore,
        user: userResolver,
      }),
    ).toThrow(/origins/)
  })
})

it('normalizes HTTP origin representations without rewriting native WebAuthn origins', async () => {
  const options = {
    rpId: 'example.com',
    rpName: 'Example',
    store: {
      create() {
        throw new Error('Configuration must not create a store')
      },
    },
    user: (sub: string) => ({ userName: sub, displayName: sub }),
  }
  const native = 'android:apk-key-hash:example'
  expect(
    resolveWebAuthnConfig({ ...options, origins: ['https://EXAMPLE.com:443/', native] }).origins,
  ).toEqual(['https://example.com', native])
  for (const origin of [
    'https://example.com/account',
    'https://user@example.com',
    'https://example.com/?locale=en',
    'https://example.com/#login',
  ]) {
    expect(() => resolveWebAuthnConfig({ ...options, origins: [origin] })).toThrow(
      'WebAuthn HTTP origins',
    )
  }
})

it('reuses static factor configuration while preparing factories for each event', async () => {
  const { createMfaAssembly } = await import('../../src/features/auth/mfa/assembly')
  const { defineMfa } = await import('../../src/features/auth/mfa/declaration')
  const { createTotpFactor } = await import('../../src/features/auth/totp/assembly')
  const { defineTotp } = await import('../../src/features/auth/totp/config')
  const { createWebAuthnFactor } = await import('../../src/features/auth/webauthn/assembly')
  const { defineWebAuthn } = await import('../../src/features/auth/webauthn/declaration')
  const { resolveHttpConfig } = await import('../../src/app/config')
  let policyReads = 0,
    totpReads = 0,
    webauthnReads = 0,
    factoryCalls = 0
  const store = {
    create() {
      throw new Error('Preparation must not create stores')
    },
  }
  const totp = createTotpFactor(
    defineTotp({
      get issuer() {
        totpReads++
        return 'Example'
      },
      keys: { current: { id: 'one', key: new Uint8Array(32) } },
      store,
    }),
  )
  const webauthn = createWebAuthnFactor(
    defineWebAuthn({
      rpId: 'example.com',
      get rpName() {
        webauthnReads++
        return 'Example'
      },
      origins: ['https://example.com'],
      user: (sub) => ({ userName: sub, displayName: sub }),
      store,
    }),
  )
  const http = resolveHttpConfig({}, false)
  const runtime = createMfaAssembly({
    mfa: defineMfa({
      get signIn() {
        policyReads++
        return 'required' as const
      },
    }),
    factors: [totp, webauthn],
  }).createRuntime()
  await runtime.prepare({ event: 1 }, http)
  const reads = [policyReads, totpReads, webauthnReads]
  expect(reads.every((count) => count > 0)).toBe(true)
  await runtime.prepare({ event: 2 }, http)
  expect([policyReads, totpReads, webauthnReads]).toEqual(reads)
  const dynamic = createMfaAssembly({
    mfa: defineMfa((env: { enabled: boolean }) => {
      factoryCalls++
      if (!env.enabled) throw new Error('Missing event configuration')
      return {}
    }),
    factors: [totp],
  }).createRuntime()
  expect(() => dynamic.prepare({ enabled: false }, http)).toThrow('Missing event configuration')
  await dynamic.prepare({ enabled: true }, http)
  await dynamic.prepare({ enabled: true }, http)
  expect(factoryCalls).toBe(3)
})
