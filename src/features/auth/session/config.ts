/**
 * First-party session declaration and configuration resolution.
 *
 * @module
 */

import { serialize } from 'hono/utils/cookie'

import {
  type BaseDeclaration,
  evaluateDeclaration,
  type RequiresEnv,
} from '../../../app/declaration'
import type { AuthCheckContext, Identity, SigningKey } from '../contracts'
import { parseSigningCredentials, resolveTokenLifetime } from './token'

/** Cookie configuration for the session token. */
export interface SessionCookieConfig {
  /** Cookie path; defaults to `'/'`. */
  readonly path?: string
  /** Cookie domain scope. */
  readonly domain?: string
  /** SameSite policy; defaults to `'lax'`. */
  readonly sameSite?: 'lax' | 'strict' | 'none'
  /** Secure attribute; defaults to true in production. */
  readonly secure?: boolean
}

/** Signing key declaration accepting a possibly missing environment secret for entry validation. */
export interface SigningKeyConfig extends Omit<SigningKey, 'secret'> {
  readonly secret: string | undefined
}

/** Required signing mode; its environment values are validated during configuration resolution. */
export type SigningConfig =
  | { readonly secret: string | undefined; readonly keys?: never }
  | { readonly keys: readonly SigningKeyConfig[] | undefined; readonly secret?: never }

/** First-party authentication configuration. */
export type AuthConfig = SigningConfig & {
  /** Cookie name used to deliver the session token; defaults to `'auth_token'`. */
  readonly cookieName?: string
  /** Cookie attributes applied to session delivery and renewal. */
  readonly cookie?: SessionCookieConfig
  /** JWT issuer (`iss`) written during signing and checked during verification. */
  readonly issuer?: string
  /** JWT audience (`aud`) written during signing and checked during verification. */
  readonly audience?: string
  /** Session validity duration in milliseconds; defaults to 7 days (604,800,000 ms). */
  readonly expiresIn?: number
  /** Maximum session lifetime from sign-in in milliseconds; defaults to 365 days. */
  readonly maxLifetime?: number
  /** Returns the subject's current credential version for comparison with the token's `ver`. */
  readonly tokenVersion?: (sub: string, context: AuthCheckContext) => Promise<number>
  /** Custom validation hook for account status, permissions, or revocation. */
  readonly validate?: (identity: Identity, context: AuthCheckContext) => Promise<boolean>
  /** Key for `validate` result caching when cacheTtl is positive. */
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
  readonly maxLifetime: number
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
type AuthInput = AuthConfig | ((env: any) => AuthConfig)

/** Auth declaration retaining its concrete configuration and environment requirements. */
export interface AuthDeclaration extends BaseDeclaration<'auth', AuthConfig> {}

/**
 * Declares first-party authentication and session management.
 *
 * @param config - Static session and credential settings.
 * @returns The auth declaration consumed by generated assembly.
 */
export function defineAuth(config: AuthConfig): AuthDeclaration

/**
 * Declares first-party authentication resolved once during application creation or per event.
 *
 * @param factory - Receives the owning instance or event environment and returns session settings.
 * @returns A declaration retaining the factory's environment requirements.
 */
export function defineAuth<E = unknown>(
  factory: (env: E) => AuthConfig,
): AuthDeclaration & RequiresEnv<E>

export function defineAuth(input: AuthInput): AuthDeclaration {
  return {
    kind: 'auth',
    value: input,
    isFactory: typeof input === 'function',
  }
}

/**
 * Resolves authentication configuration from a static object or environment factory into a materialized config.
 *
 * @param input - Declared configuration object or factory function.
 * @param env - Current instance or event environment.
 * @param isProduction - Whether production mode is active.
 * @returns Fully resolved and validated ResolvedAuthConfig.
 * @throws If factory environment is missing or credentials are invalid.
 */
export function resolveAuthConfig(
  input: AuthInput,
  env?: unknown,
  isProduction?: boolean,
): ResolvedAuthConfig {
  const value = evaluateDeclaration(input, env, 'auth')

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Auth configuration must be an options object.')
  }

  const credentials = parseSigningCredentials(value)

  const expiresIn = resolveTokenLifetime(value.expiresIn)
  const maxLifetime = value.maxLifetime === undefined ? 365 * 86_400_000 : value.maxLifetime
  if (!Number.isSafeInteger(maxLifetime) || maxLifetime <= 0) {
    throw new Error('maxLifetime must be a positive safe integer in milliseconds.')
  }

  const cacheTtl = value.cacheTtl ?? 0
  if (!Number.isFinite(cacheTtl) || cacheTtl < 0) {
    throw new Error(`cacheTtl must be a non-negative finite number, got ${cacheTtl}.`)
  }

  const config: ResolvedAuthConfig = {
    cookieName: value.cookieName ?? 'auth_token',
    cookie: {
      path: value.cookie?.path ?? '/',
      domain: value.cookie?.domain,
      sameSite: value.cookie?.sameSite ?? 'lax',
      secure: value.cookie?.secure ?? isProduction ?? false,
      httpOnly: true,
    },
    expiresIn: Math.min(expiresIn, maxLifetime),
    maxLifetime,
    issuer: value.issuer,
    audience: value.audience,
    cacheTtl,
    activeKey: credentials.activeKey,
    verifyKeys: credentials.allKeys,
    tokenVersion: value.tokenVersion,
    validate: value.validate,
    cacheKey: value.cacheKey,
  }
  serialize(config.cookieName, '', {
    ...config.cookie,
    maxAge: Math.ceil(config.expiresIn / 1000),
  })
  return config
}
