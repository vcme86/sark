import { decode } from 'hono/jwt'
import { describe, expect, it, vi } from 'vitest'

import { requireStepUp } from '../../src/features/auth/guard'
import { defineAuth, resolveAuthConfig } from '../../src/features/auth/session/config'
import { formatSetCookie, initRequestSession } from '../../src/features/auth/session/request'
import { createAuthCacheStore, createAuthService } from '../../src/features/auth/session/service'
import { signToken, verifyToken } from '../../src/features/auth/session/token'
import type { SignInInput } from '../../src/features/auth/session/types'

const SECRET = 'a-very-long-secret-key-that-is-at-least-32-bytes-long!'
const SECRET_2 = 'another-very-long-secret-key-that-is-at-least-32-bytes!'

describe('First-party Auth & Session', () => {
  describe('signToken and verifyToken', () => {
    it('preserves the same authentication facts through standalone and request session issuance', async () => {
      const input: SignInInput = {
        sub: 'reader',
        ver: 4,
        authTime: Math.floor(Date.now() / 1000),
        amr: ['pwd', 'webauthn'],
        roles: ['editor'],
        auth: { method: 'webauthn', userVerified: true },
        claims: { tenant: 'publication' },
      }
      const options = {
        secret: SECRET,
        issuer: 'publication',
        audience: 'reader',
        expiresIn: 60000,
      }
      const service = createAuthService(resolveAuthConfig(options))
      const standalone = await signToken(input, options)
      const issued = await service.issue(input)
      for (const token of [standalone, issued.token]) {
        const { payload } = decode(token)
        expect(payload.auth).toEqual(input.auth)
        expect(payload).not.toHaveProperty('authentication')
        expect(payload).not.toHaveProperty('sark_auth')
        const identity = await verifyToken(token, options)
        expect(identity).toMatchObject(input)
        expect(identity?.jti).toBeTruthy()
      }
      expect(await service.verify(issued.token)).toEqual(issued.identity)
      for (const issue of [
        (data: SignInInput) => signToken(data, options),
        (data: SignInInput) => service.issue(data),
      ]) {
        await expect(issue({ sub: 'reader', claims: { exp: 1 } })).rejects.toThrow(
          'cannot overwrite reserved session field',
        )
        await expect(
          issue({ sub: 'reader', claims: { auth: { method: 'totp' } } }),
        ).rejects.toThrow('Claim "auth" cannot overwrite reserved session field.')
      }
    })

    it('requires secret of at least 32 bytes', async () => {
      await expect(signToken({ sub: 'user-1' }, { secret: 'short-secret' })).rejects.toThrow(
        'at least 32 bytes',
      )
    })

    it('signs and verifies a valid token with a static secret', async () => {
      const token = await signToken(
        {
          sub: 'user-123',
          roles: ['admin'],
          claims: { tenantId: 'tenant-42' },
        },
        { secret: SECRET },
      )

      const identity = await verifyToken(token, { secret: SECRET })
      expect(identity).not.toBeNull()
      expect(identity?.sub).toBe('user-123')
      expect(identity?.ver).toBe(0)
      expect(identity?.roles).toEqual(['admin'])
      expect(identity?.claims).toEqual({ tenantId: 'tenant-42' })
      expect(identity?.jti).toBeDefined()
    })

    it('rejects business claims overwriting reserved session fields', async () => {
      await expect(
        signToken(
          {
            sub: 'user-1',
            claims: { sub: 'override' },
          },
          { secret: SECRET },
        ),
      ).rejects.toThrow('Claim "sub" cannot overwrite reserved session field.')
    })

    it('supports key rotation with kid and verifies retired keys', async () => {
      const keys = [
        { kid: 'key-1', secret: SECRET, retired: true },
        { kid: 'key-2', secret: SECRET_2 },
      ]

      const tokenSignedWithKey2 = await signToken({ sub: 'user-active' }, { keys })
      const verified = await verifyToken(tokenSignedWithKey2, { keys })
      expect(verified?.sub).toBe('user-active')

      // Token signed with retired key-1 can still be verified
      const tokenSignedWithKey1 = await signToken(
        { sub: 'user-retired' },
        { keys: [{ kid: 'key-1', secret: SECRET }] },
      )
      const verifiedOld = await verifyToken(tokenSignedWithKey1, { keys })
      expect(verifiedOld?.sub).toBe('user-retired')

      // Verifying with a keys array containing only retired keys succeeds
      const retiredOnlyKeys = [{ kid: 'key-1', secret: SECRET, retired: true }]
      const verifiedRetiredOnly = await verifyToken(tokenSignedWithKey1, { keys: retiredOnlyKeys })
      expect(verifiedRetiredOnly?.sub).toBe('user-retired')
    })

    it('enforces expiration and issuer/audience constraints', async () => {
      const token = await signToken(
        { sub: 'user-exp' },
        {
          secret: SECRET,
          expiresIn: 2000,
          issuer: 'https://auth.example.com',
          audience: 'https://api.example.com',
        },
      )

      // Verified with matching issuer & audience
      const valid = await verifyToken(token, {
        secret: SECRET,
        issuer: 'https://auth.example.com',
        audience: 'https://api.example.com',
      })
      expect(valid?.sub).toBe('user-exp')

      // Mismatched issuer
      const wrongIssuer = await verifyToken(token, {
        secret: SECRET,
        issuer: 'https://wrong.example.com',
      })
      expect(wrongIssuer).toBeNull()

      // Expired token after 2.5 seconds using controllable timer
      try {
        vi.useFakeTimers()
        vi.advanceTimersByTime(2500)
        const expired = await verifyToken(token, { secret: SECRET })
        expect(expired).toBeNull()
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('AuthService and hooks', () => {
    it('enforces tokenVersion and revokes outdated tokens', async () => {
      let currentVersion = 1
      const service = createAuthService(
        resolveAuthConfig({
          secret: SECRET,
          tokenVersion: async () => currentVersion,
        }),
      )

      const sessionV1 = await service.issue({ sub: 'alice', ver: 1 })
      expect(await service.verify(sessionV1.token)).not.toBeNull()

      // Upgrade tokenVersion to 2
      currentVersion = 2
      expect(await service.verify(sessionV1.token)).toBeNull()

      // Token issued with ver: 2 is accepted
      const sessionV2 = await service.issue({ sub: 'alice', ver: 2 })
      expect(await service.verify(sessionV2.token)).not.toBeNull()
    })

    it('enforces validate hook and caches result according to cacheTtl', async () => {
      const validateMock = vi.fn(async (identity: any) => identity.sub !== 'banned-user')

      const service = createAuthService(
        resolveAuthConfig({
          secret: SECRET,
          validate: validateMock,
          cacheTtl: 60,
          cacheKey: (identity) => identity.sub,
        }),
      )

      const session = await service.issue({ sub: 'bob' })

      // First verification calls hook
      const id1 = await service.verify(session.token)
      expect(id1?.sub).toBe('bob')
      expect(validateMock).toHaveBeenCalledTimes(1)

      // Second verification within cache TTL reuses cached result
      const id2 = await service.verify(session.token)
      expect(id2?.sub).toBe('bob')
      expect(validateMock).toHaveBeenCalledTimes(1)

      // Banned user verification fails
      const bannedSession = await service.issue({ sub: 'banned-user' })
      const bannedId = await service.verify(bannedSession.token)
      expect(bannedId).toBeNull()
    })

    it('runs validate for every call without an explicit key, even with a TTL', async () => {
      const validate = vi.fn(async () => true)
      const service = createAuthService(
        resolveAuthConfig({ secret: SECRET, cacheTtl: 60, validate }),
      )
      const { token } = await service.issue({ sub: 'alice' })
      await Promise.all([service.verify(token), service.verify(token)])
      await service.verify(token)
      expect(validate).toHaveBeenCalledTimes(3)
    })

    it('removes failed in-flight checks so later requests can recover', async () => {
      const validate = vi
        .fn()
        .mockImplementationOnce(() => {
          throw new Error('storage unavailable')
        })
        .mockResolvedValue(true)
      const service = createAuthService(
        resolveAuthConfig({ secret: SECRET, cacheKey: (identity) => identity.sub, validate }),
      )
      const { token } = await service.issue({ sub: 'alice' })
      await expect(service.verify(token)).rejects.toThrow('storage unavailable')
      expect((await service.verify(token))?.sub).toBe('alice')
      expect(validate).toHaveBeenCalledTimes(2)
    })

    it('propagates version-store failures and retries without caching the failed lookup', async () => {
      const tokenVersion = vi
        .fn()
        .mockRejectedValueOnce(new Error('version store unavailable'))
        .mockResolvedValue(0)
      const service = createAuthService(
        resolveAuthConfig({ secret: SECRET, tokenVersion, cacheTtl: 60 }),
      )
      const { token } = await service.issue({ sub: 'alice' })
      await expect(service.verify(token)).rejects.toThrow('version store unavailable')
      expect((await service.verify(token))?.sub).toBe('alice')
      expect(tokenVersion).toHaveBeenCalledTimes(2)
    })

    it('coalesces explicit keys even when result caching is disabled', async () => {
      let activeCalls = 0
      let maxConcurrent = 0

      const validateMock = vi.fn(async () => {
        activeCalls++
        maxConcurrent = Math.max(maxConcurrent, activeCalls)
        await new Promise((r) => setTimeout(r, 20))
        activeCalls--
        return true
      })

      const service = createAuthService(
        resolveAuthConfig({
          secret: SECRET,
          validate: validateMock,
          cacheTtl: 0,
          cacheKey: (identity) => identity.jti,
        }),
      )

      const session = await service.issue({ sub: 'concurrent-user' })

      // Fire 5 concurrent verify requests
      const results = await Promise.all([
        service.verify(session.token),
        service.verify(session.token),
        service.verify(session.token),
        service.verify(session.token),
        service.verify(session.token),
      ])

      for (const res of results) {
        expect(res?.sub).toBe('concurrent-user')
      }
      expect(validateMock).toHaveBeenCalledTimes(1)
      expect(maxConcurrent).toBe(1)
    })
  })

  it('keeps explicit signOut ahead of an asynchronous renewal already in progress', async () => {
    vi.useFakeTimers()
    try {
      const service = createAuthService(resolveAuthConfig({ secret: SECRET, expiresIn: 10000 }))
      const session = await service.issue({ sub: 'reader' })
      vi.advanceTimersByTime(6000)
      const started = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const originalRenew = service.renew
      service.renew = async (...args) => {
        started.resolve()
        await release.promise
        return originalRenew(...args)
      }
      const cookies: string[] = []
      const binding = await initRequestSession(service, {
        request: new Request('https://app.test/', {
          headers: { Cookie: `auth_token=${session.token}` },
        }),
        signal: new AbortController().signal,
        appendCookie: (cookie) => cookies.push(cookie),
        isHeadersCommitted: () => false,
      })
      const renewing = binding.onCommitHeaders()
      await started.promise
      await binding.requestAuth.signOut()
      release.resolve()
      await renewing
      expect(cookies).toHaveLength(1)
      expect(cookies[0]).toContain('Max-Age=0')
    } finally {
      vi.useRealTimers()
    }
  })

  it('limits Cookie Max-Age to the issued JWT expiration', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-27T00:00:00.800Z'))
    try {
      const service = createAuthService(resolveAuthConfig({ secret: SECRET, expiresIn: 10000 }))
      const cookies: string[] = []
      const binding = await initRequestSession(service, {
        request: new Request('https://app.test/'),
        signal: new AbortController().signal,
        appendCookie: (cookie) => cookies.push(cookie),
        isHeadersCommitted: () => false,
      })
      const issued = await binding.requestAuth.signIn({ sub: 'reader' })
      expect(Object.keys(issued).toSorted()).toEqual(['identity', 'token'])
      expect(cookies[0]).toContain('Max-Age=9')
    } finally {
      vi.useRealTimers()
    }
  })

  describe('requireStepUp middleware guard', () => {
    it('enforces authTime maxAge and throws 403 step_up_required', async () => {
      const guard = requireStepUp({ maxAge: 300_000 }) // 5 minutes
      const next = vi.fn()

      // Unauthenticated request throws 403
      await expect(guard({ var: {} } as any, next)).rejects.toMatchObject({
        status: 403,
      })

      // Old authentication (6 minutes ago) throws 403
      const sixMinutesAgoSec = Math.floor((Date.now() - 360_000) / 1000)
      const oldAuth = {
        identity: {
          sub: 'user-old',
          authTime: sixMinutesAgoSec,
          amr: ['pwd'],
        },
      }
      await expect(guard({ var: { auth: oldAuth } } as any, next)).rejects.toMatchObject({
        status: 403,
      })

      // Fresh authentication (1 minute ago) passes
      const oneMinuteAgoSec = Math.floor((Date.now() - 60_000) / 1000)
      const freshAuth = {
        identity: {
          sub: 'user-fresh',
          authTime: oneMinuteAgoSec,
          amr: ['pwd'],
        },
      }
      await guard({ var: { auth: freshAuth } } as any, next)
      expect(next).toHaveBeenCalledTimes(1)
    })

    it('enforces amr criteria and verifies required methods', async () => {
      const guard = requireStepUp({ maxAge: 300_000, amr: ['webauthn', 'totp'] })
      const next = vi.fn()

      const nowSec = Math.floor(Date.now() / 1000)

      // Only webauthn present, missing totp -> throws 403
      const partialAuth = {
        identity: {
          sub: 'user-1',
          authTime: nowSec,
          amr: ['webauthn'],
        },
      }
      await expect(guard({ var: { auth: partialAuth } } as any, next)).rejects.toThrow(
        /missing verification method "totp"/,
      )

      // Both methods present -> passes
      const validStepUp = {
        identity: {
          sub: 'user-1',
          authTime: nowSec,
          amr: ['webauthn', 'totp'],
        },
      }
      await guard({ var: { auth: validStepUp } } as any, next)
      expect(next).toHaveBeenCalledTimes(1)
    })
  })

  describe('defineAuth declaration and formatSetCookie', () => {
    it('resolves static and factory auth declarations', () => {
      const declaration = defineAuth({ secret: SECRET })
      expect(declaration.kind).toBe('auth')
      expect(declaration.isFactory).toBe(false)
      const resolved = resolveAuthConfig(declaration.value, undefined)
      expect(resolved.activeKey.secret).toBe(SECRET)

      const factoryDeclaration = defineAuth((env: { KEY: string }) => ({
        secret: env.KEY,
      }))
      expect(factoryDeclaration.isFactory).toBe(true)
      const resolvedFactory = resolveAuthConfig(factoryDeclaration.value, { KEY: SECRET })
      expect(resolvedFactory.activeKey.secret).toBe(SECRET)
    })

    it('preserves explicit secure=false in production', () => {
      const config = resolveAuthConfig(
        { secret: SECRET, cookie: { secure: false } },
        undefined,
        true,
      )
      expect(formatSetCookie(config.cookieName, 'token', config.cookie, 60)).not.toContain('Secure')
    })

    it('formats Set-Cookie with secure defaults', () => {
      const resolved = resolveAuthConfig({ secret: SECRET, cookie: { path: '/' } }, undefined, true)
      const cookie = formatSetCookie('auth_token', 'jwt-token-value', resolved.cookie, 3600)
      expect(cookie).toContain('auth_token=jwt-token-value')
      expect(cookie).toContain('Path=/')
      expect(cookie).toContain('HttpOnly')
      expect(cookie).toContain('SameSite=Lax')
      expect(cookie).toContain('Max-Age=3600')
      expect(cookie).toContain('Secure')
    })
  })
})

it('bounds both hook caches and rechecks evicted credentials without changing cache hits', async () => {
  const cache = createAuthCacheStore()
  const tokenVersion = vi.fn(async () => 0)
  const validate = vi.fn(async () => true)
  const service = createAuthService(
    resolveAuthConfig({
      secret: SECRET,
      cacheTtl: 60,
      tokenVersion,
      validate,
      cacheKey: (identity) => identity.sub,
    }),
    {},
    cache,
  )
  let first = ''
  let last = ''
  for (let index = 0; index <= 2000; index++) {
    const token = await signToken({ sub: `reader-${index}`, ver: 0 }, { secret: SECRET })
    if (index === 0) first = token
    last = token
    await service.verify(token)
  }
  expect(cache.versionCache.size).toBe(2000)
  expect(cache.validateCache.size).toBe(2000)
  expect(cache.versionInFlight.size).toBe(0)
  expect(cache.validateInFlight.size).toBe(0)
  expect(tokenVersion).toHaveBeenCalledTimes(2001)
  expect(validate).toHaveBeenCalledTimes(2001)
  expect((await service.verify(last))?.sub).toBe('reader-2000')
  expect(tokenVersion).toHaveBeenCalledTimes(2001)
  expect(validate).toHaveBeenCalledTimes(2001)
  expect((await service.verify(first))?.sub).toBe('reader-0')
  expect(tokenVersion).toHaveBeenCalledTimes(2002)
  expect(validate).toHaveBeenCalledTimes(2002)
  expect(cache.versionCache.size).toBe(2000)
  expect(cache.validateCache.size).toBe(2000)
}, 10000)

it('checks fixed Cookie prefix rules before opening application resources', async () => {
  const { createApp } = await import('../../src/app/create')
  const { createDefinition } = await import('../../src/app/definition')
  const { createAuthAssembly } = await import('../../src/features/auth/session/assembly')
  const opened = vi.fn(async () => ({ value: {} }))
  const definition = createDefinition({
    resources: { selected: { createStatic: opened } },
    services: {
      auth: createAuthAssembly(
        defineAuth({ secret: SECRET, cookieName: '__Secure-session', cookie: { secure: false } }),
      ),
    },
  })
  await expect(createApp(definition)).rejects.toThrow('__Secure-')
  expect(opened).not.toHaveBeenCalled()
})
