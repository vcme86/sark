/**
 * First-party session declaration and configuration resolution.
 *
 * @module
 */

import type { BaseDeclaration, RequiresEnv } from '../../../core/declaration'
import type { AuthCheckContext, Identity, SigningCredentials } from '../contracts'
import { parseSigningCredentials, resolveTokenLifetime } from './token'

/** Cookie configuration for the session token. */
export interface SessionCookieOptions {
  /** Cookie path; defaults to `'/'`. */
  readonly path?: string
  /** Cookie domain scope. */
  readonly domain?: string
  /** SameSite policy; defaults to `'lax'`. */
  readonly sameSite?: 'lax' | 'strict' | 'none'
  /** Secure attribute; defaults to true in production. */
  readonly secure?: boolean
}

/** Configuration options for first-party authentication. */
export type AuthOptions = SigningCredentials & {
  /** Cookie name used to deliver the session token; defaults to `'auth_token'`. */
  readonly cookieName?: string
  /** Cookie attributes applied to session delivery and renewal. */
  readonly cookie?: SessionCookieOptions
  /** JWT issuer (`iss`) written during signing and checked during verification. */
  readonly issuer?: string
  /** JWT audience (`aud`) written during signing and checked during verification. */
  readonly audience?: string
  /** Session validity duration in milliseconds; defaults to 7 days (604,800,000 ms). */
  readonly expiresIn?: number
  /** Whether to automatically renew the cookie when less than half the lifetime remains; defaults to `true`. */
  readonly rolling?: boolean
  /** Returns the subject's current credential version for comparison with the token's `ver`. */
  readonly tokenVersion?: (sub: string, context: AuthCheckContext) => Promise<number>
  /** Custom validation hook for account status, permissions, or revocation. */
  readonly validate?: (identity: Identity, context: AuthCheckContext) => Promise<boolean>
  /** Key for `validate` result caching and concurrent in-flight check coalescing. */
  readonly cacheKey?: (identity: Identity, context: AuthCheckContext) => string
  /** Cache TTL in seconds for hook results; defaults to 0 (caching disabled). */
  readonly cacheTtl?: number
}

/** Fully resolved authentication settings with all defaults materialized. */
export interface ResolvedAuthConfig {
  readonly cookieName: string
  readonly cookie: {
    readonly path: string
    readonly domain?: string
    readonly sameSite: 'lax' | 'strict' | 'none'
    readonly secure: boolean
    readonly httpOnly: boolean
  }
  readonly expiresIn: number
  readonly rolling: boolean
  readonly issuer?: string
  readonly audience?: string
  readonly cacheTtl: number
  readonly activeKey: { readonly secret: string; readonly kid?: string }
  readonly verifyKeys: ReadonlyMap<string, string>
  readonly tokenVersion?: (sub: string, context: AuthCheckContext) => Promise<number>
  readonly validate?: (identity: Identity, context: AuthCheckContext) => Promise<boolean>
  readonly cacheKey?: (identity: Identity, context: AuthCheckContext) => string
}

/** Configuration input consumed by the authentication resolver. */
export type AuthInput = AuthOptions | ((env: any) => AuthOptions)

/** Auth declaration retaining its concrete options and environment requirements. */
export interface AuthDeclaration extends BaseDeclaration<'auth', AuthOptions> {}

/**
 * Declares first-party authentication and session management.
 *
 * @param options - Static session and credential settings.
 * @returns The auth declaration consumed by generated assembly.
 */
export function defineAuth(options: AuthOptions): AuthDeclaration

/**
 * Declares first-party authentication resolved once during application creation or per event.
 *
 * @param factory - Receives the owning instance or event environment and returns session settings.
 * @returns A declaration retaining the factory's environment requirements.
 */
export function defineAuth<E = unknown>(
  factory: (env: E) => AuthOptions,
): AuthDeclaration & RequiresEnv<E>

export function defineAuth(optionsOrFactory: AuthInput): AuthDeclaration {
  return {
    kind: 'auth',
    isFactory: typeof optionsOrFactory === 'function',
    value: optionsOrFactory,
  }
}

/**
 * Resolves authentication options from a static object or environment factory into a materialized config.
 *
 * @param input - Declared options object or factory function.
 * @param env - Current instance or event environment.
 * @param isProduction - Whether production mode is active.
 * @returns Fully resolved and validated ResolvedAuthConfig.
 * @throws If factory environment is missing or credentials are invalid.
 */
export function resolveAuthConfig(
  input: AuthInput | AuthDeclaration,
  env?: unknown,
  isProduction?: boolean,
): ResolvedAuthConfig {
  const actualInput =
    input && typeof input === 'object' && 'kind' in input && input.kind === 'auth'
      ? (input as AuthDeclaration).value
      : input

  let value: AuthOptions
  if (typeof actualInput === 'function') {
    if (env === undefined) {
      throw new Error('Environment required by auth declaration factory was not provided.')
    }
    value = (actualInput as (env: any) => AuthOptions)(env)
  } else {
    value = actualInput as AuthOptions
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Auth configuration must be an options object.')
  }

  const credentials = parseSigningCredentials(value)

  const cookieName = value.cookieName ?? 'auth_token'
  const path = value.cookie?.path ?? '/'
  const sameSite = value.cookie?.sameSite ?? 'lax'
  const domain = value.cookie?.domain
  const secure = value.cookie?.secure ?? isProduction ?? false
  const httpOnly = true

  const expiresIn = resolveTokenLifetime(value.expiresIn)

  const cacheTtl = value.cacheTtl ?? 0
  if (typeof cacheTtl !== 'number' || !Number.isFinite(cacheTtl) || cacheTtl < 0) {
    throw new Error(`cacheTtl must be a non-negative finite number, got ${cacheTtl}.`)
  }

  const rolling = value.rolling !== false

  return {
    cookieName,
    cookie: {
      path,
      domain,
      sameSite,
      secure,
      httpOnly,
    },
    expiresIn,
    rolling,
    issuer: value.issuer,
    audience: value.audience,
    cacheTtl,
    activeKey: credentials.activeKey,
    verifyKeys: credentials.allKeys,
    tokenVersion: value.tokenVersion,
    validate: value.validate,
    cacheKey: value.cacheKey,
  }
}
