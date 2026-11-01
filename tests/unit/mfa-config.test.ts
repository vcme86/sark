import { describe, expect, it } from 'vitest'

import { sqlRecovery } from '../../src/entries/auth/recovery-sqlite'
import { sqlTotp } from '../../src/entries/auth/totp-sqlite'
import { sqlWebAuthn } from '../../src/entries/auth/webauthn-sqlite'
import { resolveMfaConfig } from '../../src/services/auth/mfa/config'
import type { MfaConfig } from '../../src/services/auth/mfa/types'
import { resolveTotpConfig } from '../../src/services/auth/totp/config'
import { resolveWebAuthnConfig } from '../../src/services/auth/webauthn/config'
import { defineDatabase } from '../../src/services/db/sqlite'

describe('MFA configuration', () => {
  it('applies defaults when empty configuration object is passed', () => {
    const resolved = resolveMfaConfig({})
    expect(resolved.login).toBe('if-enrolled')
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
