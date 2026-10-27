/**
 * Cryptographic token signing, verification, and claim transformation reusing Hono JWT.
 *
 * @module
 */

import { decode, sign, verify } from 'hono/jwt'
import { encodeBase64Url } from 'hono/utils/encode'

import type { AuthenticationFacts, Identity, SigningCredentials, SigningKey } from '../contracts'
import type { IssuedSession, SignInInput } from './types'

/** Claims reserved by Sark authentication tokens that cannot be overridden by custom claims. */
export const RESERVED_CLAIMS = new Set([
  'sub',
  'ver',
  'jti',
  'iat',
  'exp',
  'nbf',
  'iss',
  'aud',
  'auth_time',
  'amr',
  'roles',
  'sark_auth',
])

const textEncoder = new TextEncoder()

/** Resolves the shared session lifetime at a declaration or standalone signing entry. */
export function resolveTokenLifetime(input?: number): number {
  const expiresIn = input === undefined ? 604_800_000 : input
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error(`expiresIn must be a positive finite number, got ${expiresIn}.`)
  }
  return expiresIn
}

/** Asserts that a secret is at least 32 UTF-8 bytes for HS256 compliance. */
export function validateSecretLength(secret: string, keyDesc = 'secret'): void {
  if (typeof secret !== 'string') {
    throw new Error(`Signing ${keyDesc} must be a string.`)
  }
  const bytes = textEncoder.encode(secret).length
  if (bytes < 32) {
    throw new Error(`Signing ${keyDesc} must be at least 32 bytes (got ${bytes}).`)
  }
}

/** Validates verification credentials, allowing sets of only retired keys. */
export function parseVerificationCredentials(
  credentials: SigningCredentials,
): ReadonlyMap<string, string> {
  if ('secret' in credentials && credentials.secret !== undefined) {
    validateSecretLength(credentials.secret, 'secret')
    return new Map([['', credentials.secret]])
  }

  const keys = credentials.keys
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new Error('Signing keys must be a non-empty array.')
  }

  const allKeys = new Map<string, string>()
  for (const key of keys) {
    if (!key.kid || typeof key.kid !== 'string') {
      throw new Error('Every signing key must have a non-empty string kid.')
    }
    if (allKeys.has(key.kid)) {
      throw new Error(`Duplicate signing key kid: "${key.kid}".`)
    }
    validateSecretLength(key.secret, `key "${key.kid}"`)
    allKeys.set(key.kid, key.secret)
  }

  return allKeys
}

/** Validates and parses signing credentials, returning resolved active signing key and lookup map. */
export function parseSigningCredentials(credentials: SigningCredentials): {
  readonly activeKey: { readonly secret: string; readonly kid?: string }
  readonly allKeys: ReadonlyMap<string, string>
} {
  const allKeys = parseVerificationCredentials(credentials)

  if ('secret' in credentials && credentials.secret !== undefined) {
    return {
      activeKey: { secret: allKeys.get('')! },
      allKeys,
    }
  }

  const keys = credentials.keys!
  const activeKeys: SigningKey[] = keys.filter((k) => !k.retired)

  if (activeKeys.length === 0) {
    throw new Error('At least one non-retired signing key is required for token issuance.')
  }
  if (activeKeys.length > 1) {
    throw new Error(
      `Multiple active signing keys configured (${activeKeys.map((k) => k.kid).join(', ')}). Exactly one key must be active for signing.`,
    )
  }

  return {
    activeKey: { secret: activeKeys[0].secret, kid: activeKeys[0].kid },
    allKeys,
  }
}

/** Options for assembling a token payload. */
export interface TokenPayloadOptions {
  /** Unique subject identifier. */
  readonly sub: string
  /** Version number of credentials. */
  readonly ver: number
  /** Token identifier. */
  readonly jti: string
  /** Issue time in Unix seconds. */
  readonly iat: number
  /** Expiration time in Unix seconds. */
  readonly exp: number
  /** Expected token issuer. */
  readonly issuer?: string
  /** Expected token audience. */
  readonly audience?: string
  /** Custom unreserved claims. */
  readonly claims?: Readonly<Record<string, unknown>>
  /** Time of original authentication in Unix seconds. */
  readonly authTime?: number
  /** Authentication Methods References. */
  readonly amr?: readonly string[]
  /** Assigned roles. */
  readonly roles?: readonly string[]
  /** Specific MFA facts. */
  readonly authentication?: AuthenticationFacts
}

/**
 * Assembles standard and custom JWT claims into a signing payload.
 *
 * @param options - Named claim options.
 * @returns Fully constructed payload object.
 */
export function buildTokenPayload(options: TokenPayloadOptions): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    ...options.claims,
    sub: options.sub,
    ver: options.ver,
    jti: options.jti,
    iat: options.iat,
    exp: options.exp,
  }

  if (options.issuer !== undefined) payload.iss = options.issuer
  if (options.audience !== undefined) payload.aud = options.audience
  if (options.authTime !== undefined) payload.auth_time = options.authTime
  if (options.amr && options.amr.length > 0) payload.amr = [...options.amr]
  if (options.roles && options.roles.length > 0) payload.roles = [...options.roles]
  if (options.authentication) payload.sark_auth = options.authentication

  return payload
}

/**
 * Extracts an Identity object from verified JWT claims.
 *
 * @param payload - Verified raw JWT claims dictionary.
 * @returns Parsed Identity, or null if the payload lacks a valid subject.
 */
export function buildIdentityFromPayload(payload: Record<string, unknown>): Identity | null {
  if (typeof payload.sub !== 'string' || !payload.sub) return null
  const ver = typeof payload.ver === 'number' ? payload.ver : 0
  const jti = typeof payload.jti === 'string' ? payload.jti : ''

  const amr = Array.isArray(payload.amr)
    ? payload.amr.filter((a) => typeof a === 'string')
    : undefined
  const authTime = typeof payload.auth_time === 'number' ? payload.auth_time : undefined
  const roles = Array.isArray(payload.roles)
    ? payload.roles.filter((r) => typeof r === 'string')
    : undefined
  const authentication =
    payload.sark_auth && typeof payload.sark_auth === 'object'
      ? (payload.sark_auth as AuthenticationFacts)
      : undefined

  const claims: Record<string, unknown> = {}
  for (const [key, val] of Object.entries(payload)) {
    if (!RESERVED_CLAIMS.has(key)) {
      claims[key] = val
    }
  }

  return {
    sub: payload.sub,
    ver,
    jti,
    ...(amr ? { amr } : {}),
    ...(authTime !== undefined ? { authTime } : {}),
    ...(roles ? { roles } : {}),
    ...(authentication ? { authentication } : {}),
    claims,
  }
}

/**
 * Signs a payload with an active signing key using Hono's sign().
 *
 * @param payload - JWT payload dictionary.
 * @param activeKey - Active secret key and optional kid identifier.
 * @returns The signed JWT string.
 */
export async function signWithKey(
  payload: Record<string, unknown>,
  activeKey: { readonly secret: string; readonly kid?: string },
): Promise<string> {
  if (activeKey.kid) {
    return sign(
      payload,
      {
        kty: 'oct',
        alg: 'HS256',
        kid: activeKey.kid,
        k: encodeBase64Url(textEncoder.encode(activeKey.secret).buffer).replace(/=+$/, ''),
      },
      'HS256',
    )
  }
  return sign(payload, activeKey.secret, 'HS256')
}

/** Internal issuance result retaining expiration for Cookie delivery. */
export interface IssuedToken extends IssuedSession {
  readonly expiresAt: number
}

/** Complete signing settings supplied by the owning configuration entry. */
interface TokenSigningOptions {
  readonly activeKey: { readonly secret: string; readonly kid?: string }
  readonly expiresIn: number
  readonly issuer?: string
  readonly audience?: string
}

/** Issues one new identity and token; rolling renewal retains its own original identity. */
export async function issueToken(
  input: SignInInput,
  options: TokenSigningOptions,
): Promise<IssuedToken> {
  if (!input.sub || typeof input.sub !== 'string') {
    throw new Error('Session sub is required and must be a non-empty string.')
  }
  for (const key of Object.keys(input.claims ?? {})) {
    if (RESERVED_CLAIMS.has(key)) {
      throw new Error(`Claim "${key}" cannot overwrite reserved session field.`)
    }
  }

  const identity: Identity = {
    sub: input.sub,
    ver: input.ver ?? 0,
    jti: crypto.randomUUID(),
    ...(input.amr ? { amr: input.amr } : {}),
    ...(input.authTime !== undefined ? { authTime: input.authTime } : {}),
    ...(input.roles ? { roles: input.roles } : {}),
    ...(input.authentication ? { authentication: input.authentication } : {}),
    claims: input.claims ?? {},
  }
  const now = Math.floor(Date.now() / 1000)
  const expiresAt = now + Math.ceil(options.expiresIn / 1000)
  const payload = buildTokenPayload({
    ...identity,
    iat: now,
    exp: expiresAt,
    issuer: options.issuer,
    audience: options.audience,
  })
  return { identity, token: await signWithKey(payload, options.activeKey), expiresAt }
}

/** Internal token verification result retaining identity and expiration metadata. */
export interface VerifiedTokenResult {
  readonly identity: Identity
  readonly iat?: number
  readonly exp?: number
}

/**
 * Verifies a token with a key lookup map, asserting alg === 'HS256' and matching kid.
 *
 * @param token - Raw JWT string.
 * @param verifyKeys - Map of kid to secret key strings.
 * @param options - Expected issuer and audience constraints.
 * @returns The verified token metadata, or null if validation fails.
 */
export async function verifyTokenWithKeys(
  token: string,
  verifyKeys: ReadonlyMap<string, string>,
  options?: { readonly issuer?: string; readonly audience?: string },
): Promise<VerifiedTokenResult | null> {
  if (typeof token !== 'string' || !token) return null

  let decodedHeader: ReturnType<typeof decode>['header']
  try {
    const decoded = decode(token)
    decodedHeader = decoded.header
  } catch {
    return null
  }

  if (decodedHeader?.alg !== 'HS256') {
    return null
  }

  const kid = decodedHeader.kid
  let secret: string | undefined
  if (typeof kid === 'string' && kid) {
    secret = verifyKeys.get(kid)
  } else if (!kid) {
    secret = verifyKeys.get('')
  }

  if (!secret) {
    return null
  }

  let verifiedPayload: Record<string, unknown>
  try {
    verifiedPayload = await verify(token, secret, {
      alg: 'HS256',
      iss: options?.issuer,
      aud: options?.audience,
    })
  } catch {
    return null
  }

  const identity = buildIdentityFromPayload(verifiedPayload)
  if (!identity) return null

  return {
    identity,
    iat: typeof verifiedPayload.iat === 'number' ? verifiedPayload.iat : undefined,
    exp: typeof verifiedPayload.exp === 'number' ? verifiedPayload.exp : undefined,
  }
}

/**
 * Signs a session token with HS256 using Hono's sign() and the active signing credentials.
 *
 * @param input - Claims and identity information.
 * @param options - Signing credentials, optional lifetime in milliseconds (default: seven days), issuer, and audience.
 * @returns The signed JWT string.
 * @throws If signing credentials, the lifetime, or identity claims are invalid.
 */
export async function signToken(
  input: SignInInput,
  options: SigningCredentials & {
    readonly issuer?: string
    readonly audience?: string
    readonly expiresIn?: number
  },
): Promise<string> {
  const { activeKey } = parseSigningCredentials(options)
  const issued = await issueToken(input, {
    activeKey,
    expiresIn: resolveTokenLifetime(options.expiresIn),
    issuer: options.issuer,
    audience: options.audience,
  })
  return issued.token
}

/**
 * Directly verifies a raw JWT string against signing credentials without executing application hooks.
 *
 * @param token - Raw JWT string.
 * @param options - Signing credentials and expected claims.
 * @returns Validated identity, or null if invalid or expired.
 * @throws If verification credentials are invalid.
 */
export async function verifyToken(
  token: string,
  options: SigningCredentials & {
    readonly issuer?: string
    readonly audience?: string
  },
): Promise<Identity | null> {
  const allKeys = parseVerificationCredentials(options)
  const result = await verifyTokenWithKeys(token, allKeys, {
    issuer: options.issuer,
    audience: options.audience,
  })
  return result?.identity ?? null
}
