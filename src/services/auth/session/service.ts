/**
 * First-party session verification, authentication hooks, and result caching.
 *
 * @module
 */

import { getLogger, lazy } from '@logtape/logtape'

import { getRequestId } from '../../../core/context'
import type { AuthCheckContext, Identity } from '../contracts'
import type { ResolvedAuthConfig } from './config'
import { extractCredentials } from './request'
import {
  buildTokenPayload,
  type IssuedToken,
  issueToken,
  signWithKey,
  type VerifiedTokenResult,
  verifyTokenWithKeys,
} from './token'
import type { AuthService, SignInInput } from './types'

interface CacheEntry<T> {
  readonly value: T
  readonly expiresAt: number
}

function cleanExpired<T>(cache: Map<string, CacheEntry<T>>, now: number): void {
  if (cache.size > 2000) {
    for (const [k, v] of cache) {
      if (now >= v.expiresAt) cache.delete(k)
    }
  }
}

/** Cache store for hook results and concurrent in-flight promise coalescing. */
export interface AuthCacheStore {
  readonly validateCache: Map<string, CacheEntry<boolean>>
  readonly validateInFlight: Map<string, Promise<boolean>>
  readonly versionCache: Map<string, CacheEntry<number | null>>
  readonly versionInFlight: Map<string, Promise<number | null>>
}

/** Creates a fresh cache store instance. */
export function createAuthCacheStore(): AuthCacheStore {
  return {
    validateCache: new Map(),
    validateInFlight: new Map(),
    versionCache: new Map(),
    versionInFlight: new Map(),
  }
}

/** Internal service interface holding session issuance, renewal, and detailed verification. */
export interface InternalAuthService extends AuthService {
  /** Issues a new session and signed JWT for RequestAuth.signIn. */
  issue(input: SignInInput): Promise<IssuedToken>
  /** Renews an existing session, extending expiration while retaining original facts (jti, iat). */
  renew(identity: Identity, originalIat?: number): Promise<IssuedToken>
  /** Verifies token returning identity along with iat/exp metadata. */
  verifyInternal(
    token: string,
    options?: { readonly request?: Request; readonly signal?: AbortSignal },
  ): Promise<VerifiedTokenResult | null>
  /** Resolved configuration options for this service. */
  readonly options: ResolvedAuthConfig
}

/**
 * Creates an application-level AuthService instance.
 *
 * @param options - Materialized authentication settings.
 * @param resources - Resources belonging to the current application instance or event.
 * @param cacheStore - Optional shared cache store (reused across Workers events).
 * @returns Ready InternalAuthService.
 */
export function createAuthService(
  options: ResolvedAuthConfig,
  resources: Readonly<Record<string, unknown>> = {},
  cacheStore: AuthCacheStore = createAuthCacheStore(),
): InternalAuthService {
  const logger = getLogger(['app', 'auth']).with({ requestId: lazy(getRequestId) })
  const cacheTtlMs = options.cacheTtl * 1000

  const { validateCache, validateInFlight, versionCache, versionInFlight } = cacheStore

  async function getExpectedVersion(
    identity: Identity,
    token: string,
    context: AuthCheckContext,
  ): Promise<number | null> {
    if (!options.tokenVersion) return identity.ver

    const now = Date.now()
    if (cacheTtlMs > 0) {
      const cached = versionCache.get(token)
      if (cached && now < cached.expiresAt) {
        return cached.value
      }
      cleanExpired(versionCache, now)
      const existing = versionInFlight.get(token)
      if (existing) return existing
    }

    const versionPromise = Promise.resolve().then(async () => {
      try {
        const expected = await options.tokenVersion!(identity.sub, context)
        if (cacheTtlMs > 0) {
          versionCache.set(token, { value: expected, expiresAt: Date.now() + cacheTtlMs })
        }
        return expected
      } catch (err) {
        logger.error('Error invoking tokenVersion hook for sub {sub}: {error}', {
          sub: identity.sub,
          error: err,
        })
        return null
      } finally {
        if (cacheTtlMs > 0) {
          versionInFlight.delete(token)
        }
      }
    })

    if (cacheTtlMs > 0) {
      versionInFlight.set(token, versionPromise)
    }

    return versionPromise
  }

  async function runValidate(identity: Identity, context: AuthCheckContext): Promise<boolean> {
    if (!options.validate) return true
    const key = options.cacheKey?.(identity, context)
    const now = Date.now()
    if (key !== undefined) {
      const cached = validateCache.get(key)
      if (cached && now < cached.expiresAt) return cached.value
      cleanExpired(validateCache, now)
      const pending = validateInFlight.get(key)
      if (pending) return pending
    }

    // Defer the hook so even a synchronous throw settles after in-flight registration.
    const pending = Promise.resolve()
      .then(() => options.validate!(identity, context))
      .then(
        (valid) => {
          if (key !== undefined && cacheTtlMs > 0) {
            validateCache.set(key, { value: valid, expiresAt: Date.now() + cacheTtlMs })
          }
          return valid
        },
        (error) => {
          logger.error('Error invoking validate hook for sub {sub}: {error}', {
            sub: identity.sub,
            error,
          })
          return false
        },
      )
      .finally(() => {
        if (key !== undefined) validateInFlight.delete(key)
      })
    if (key !== undefined) validateInFlight.set(key, pending)
    return pending
  }

  const authService: InternalAuthService = {
    options,

    issue: (input) => issueToken(input, options),

    async renew(identity: Identity, originalIat?: number): Promise<IssuedToken> {
      const now = Math.floor(Date.now() / 1000)
      const exp = now + Math.ceil(options.expiresIn / 1000)

      const payload = buildTokenPayload({
        sub: identity.sub,
        ver: identity.ver,
        jti: identity.jti,
        iat: originalIat ?? now,
        exp,
        issuer: options.issuer,
        audience: options.audience,
        claims: identity.claims,
        authTime: identity.authTime,
        amr: identity.amr,
        roles: identity.roles,
        authentication: identity.authentication,
      })

      const token = await signWithKey(payload, options.activeKey)
      return { identity, token, expiresAt: exp }
    },

    async verifyInternal(
      token: string,
      execOptions?: { readonly request?: Request; readonly signal?: AbortSignal },
    ): Promise<VerifiedTokenResult | null> {
      const verified = await verifyTokenWithKeys(token, options.verifyKeys, {
        issuer: options.issuer,
        audience: options.audience,
      })
      if (!verified) return null

      const context: AuthCheckContext = {
        logger,
        signal: execOptions?.signal,
        request: execOptions?.request,
        ...resources,
      }

      const expectedVer = await getExpectedVersion(verified.identity, token, context)
      if (expectedVer === null || verified.identity.ver !== expectedVer) {
        return null
      }

      const isValid = await runValidate(verified.identity, context)
      if (!isValid) {
        return null
      }

      return verified
    },

    async verify(
      token: string,
      execOptions?: { readonly request?: Request; readonly signal?: AbortSignal },
    ): Promise<Identity | null> {
      const result = await authService.verifyInternal(token, execOptions)
      return result?.identity ?? null
    },

    async authenticate(request: Request): Promise<Identity | null> {
      const creds = extractCredentials(request, options.cookieName)
      if (!creds) return null
      return authService.verify(creds.token, { request, signal: request.signal })
    },
  }

  return authService
}
