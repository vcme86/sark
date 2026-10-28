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

const MAX_CACHE_ENTRIES = 2000

function readCached<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
  now: number,
): CacheEntry<T> | undefined {
  const entry = cache.get(key)
  if (entry && now >= entry.expiresAt) {
    cache.delete(key)
    return undefined
  }
  return entry
}

function cacheResult<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
  entry: CacheEntry<T>,
): void {
  if (cache.size >= MAX_CACHE_ENTRIES && !cache.has(key)) {
    cache.delete(cache.keys().next().value!)
  }
  cache.set(key, entry)
}

/**
 * Owns independently bounded hook-result caches and concurrent verification work.
 * TTL controls reuse; in-flight entries are removed when their work settles.
 */
export interface AuthCacheStore {
  readonly validateCache: Map<string, CacheEntry<boolean>>
  readonly validateInFlight: Map<string, Promise<boolean>>
  readonly versionCache: Map<string, CacheEntry<number>>
  readonly versionInFlight: Map<string, Promise<number>>
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
  readonly config: ResolvedAuthConfig
}

/**
 * Creates an application-level AuthService instance.
 *
 * @param config - Materialized authentication settings.
 * @param resources - Resources belonging to the current application instance or event.
 * @param cacheStore - Optional shared cache store (reused across Workers events).
 * @returns Ready InternalAuthService.
 */
export function createAuthService(
  config: ResolvedAuthConfig,
  resources: Readonly<Record<string, unknown>> = {},
  cacheStore: AuthCacheStore = createAuthCacheStore(),
): InternalAuthService {
  const logger = getLogger(['app', 'auth']).with({ requestId: lazy(getRequestId) })
  const cacheTtlMs = config.cacheTtl * 1000

  const { validateCache, validateInFlight, versionCache, versionInFlight } = cacheStore

  async function getExpectedVersion(
    identity: Identity,
    token: string,
    context: AuthCheckContext,
  ): Promise<number> {
    if (!config.tokenVersion) return identity.ver

    if (cacheTtlMs > 0) {
      const cached = readCached(versionCache, token, Date.now())
      if (cached) {
        return cached.value
      }
      const existing = versionInFlight.get(token)
      if (existing) return existing
    }

    const versionPromise = Promise.resolve().then(async () => {
      try {
        const expected = await config.tokenVersion!(identity.sub, context)
        if (cacheTtlMs > 0) {
          cacheResult(versionCache, token, { value: expected, expiresAt: Date.now() + cacheTtlMs })
        }
        return expected
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
    if (!config.validate) return true
    const key = config.cacheKey?.(identity, context)
    if (key !== undefined) {
      const cached = readCached(validateCache, key, Date.now())
      if (cached) return cached.value
      const pending = validateInFlight.get(key)
      if (pending) return pending
    }

    // Defer the hook so even a synchronous throw settles after in-flight registration.
    const pending = Promise.resolve()
      .then(() => config.validate!(identity, context))
      .then((valid) => {
        if (key !== undefined && cacheTtlMs > 0) {
          cacheResult(validateCache, key, { value: valid, expiresAt: Date.now() + cacheTtlMs })
        }
        return valid
      })
      .finally(() => {
        if (key !== undefined) validateInFlight.delete(key)
      })
    if (key !== undefined) validateInFlight.set(key, pending)
    return pending
  }

  const authService: InternalAuthService = {
    config,

    issue: (input) => issueToken(input, config),

    async renew(identity: Identity, originalIat?: number): Promise<IssuedToken> {
      const now = Math.floor(Date.now() / 1000)
      const exp = now + Math.ceil(config.expiresIn / 1000)

      const payload = buildTokenPayload({
        sub: identity.sub,
        ver: identity.ver,
        jti: identity.jti,
        iat: originalIat ?? now,
        exp,
        issuer: config.issuer,
        audience: config.audience,
        claims: identity.claims,
        authTime: identity.authTime,
        amr: identity.amr,
        roles: identity.roles,
        authentication: identity.authentication,
      })

      const token = await signWithKey(payload, config.activeKey)
      return { identity, token, expiresAt: exp }
    },

    async verifyInternal(
      token: string,
      execOptions?: { readonly request?: Request; readonly signal?: AbortSignal },
    ): Promise<VerifiedTokenResult | null> {
      const verified = await verifyTokenWithKeys(token, config.verifyKeys, {
        issuer: config.issuer,
        audience: config.audience,
      })
      if (!verified) return null

      const context: AuthCheckContext = {
        logger,
        signal: execOptions?.signal,
        request: execOptions?.request,
        ...resources,
      }

      const expectedVer = await getExpectedVersion(verified.identity, token, context)
      if (verified.identity.ver !== expectedVer) {
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
      const creds = extractCredentials(request, config.cookieName)
      if (!creds) return null
      return authService.verify(creds.token, { request, signal: request.signal })
    },
  }

  return authService
}
