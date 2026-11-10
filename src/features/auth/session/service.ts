/**
 * First-party session verification, authentication hooks, and result caching.
 *
 * @module
 */

import { getLogger, lazy } from '@logtape/logtape'

import { getRequestId } from '../../../app/context'
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

/** Owns bounded caches for completed authentication hook results. */
export interface AuthCacheStore {
  readonly validateCache: Map<string, CacheEntry<boolean>>
  readonly versionCache: Map<string, CacheEntry<number>>
}

/** Creates a fresh cache store instance. */
export function createAuthCacheStore(): AuthCacheStore {
  return {
    validateCache: new Map(),
    versionCache: new Map(),
  }
}

/** Internal service interface holding session issuance, renewal, and detailed verification. */
export interface InternalAuthService extends AuthService {
  /** Issues a new session and signed JWT for RequestAuth.signIn. */
  issue(input: SignInInput): Promise<IssuedToken>
  /** Renews an existing session, extending expiration while retaining original facts (jti, iat). */
  renew(identity: Identity, issuedAt: number, expiresAt: number): Promise<IssuedToken | undefined>
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

  const { validateCache, versionCache } = cacheStore
  const lifetimeSeconds = Math.ceil(config.maxLifetime / 1000)
  const expirySeconds = Math.ceil(config.expiresIn / 1000)

  async function getExpectedVersion(
    identity: Identity,
    token: string,
    context: AuthCheckContext,
  ): Promise<number> {
    if (!config.tokenVersion) return identity.ver
    const cached = cacheTtlMs > 0 ? readCached(versionCache, token, Date.now()) : undefined
    if (cached) return cached.value

    const expected = await config.tokenVersion(identity.sub, context)
    if (cacheTtlMs > 0) {
      cacheResult(versionCache, token, { value: expected, expiresAt: Date.now() + cacheTtlMs })
    }
    return expected
  }

  async function runValidate(identity: Identity, context: AuthCheckContext): Promise<boolean> {
    if (!config.validate) return true
    const key = cacheTtlMs > 0 ? config.cacheKey?.(identity, context) : undefined
    if (key !== undefined) {
      const cached = readCached(validateCache, key, Date.now())
      if (cached) return cached.value
    }

    const valid = await config.validate(identity, context)
    if (key !== undefined) {
      cacheResult(validateCache, key, { value: valid, expiresAt: Date.now() + cacheTtlMs })
    }
    return valid
  }

  const authService: InternalAuthService = {
    config,

    issue: (input) => issueToken(input, config),

    async renew(identity, issuedAt, expiresAt) {
      const now = Math.floor(Date.now() / 1000)
      const exp = Math.min(now + expirySeconds, issuedAt + lifetimeSeconds)
      if (exp <= expiresAt || exp <= now) return undefined

      const payload = buildTokenPayload({
        sub: identity.sub,
        ver: identity.ver,
        jti: identity.jti,
        iat: issuedAt,
        exp,
        issuer: config.issuer,
        audience: config.audience,
        claims: identity.claims,
        authTime: identity.authTime,
        amr: identity.amr,
        roles: identity.roles,
        auth: identity.auth,
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
      if (
        !verified ||
        verified.iat === undefined ||
        verified.exp === undefined ||
        Date.now() >= (verified.iat + lifetimeSeconds) * 1000
      )
        return null

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
