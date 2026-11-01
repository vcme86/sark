/**
 * Shared identity, authentication facts, token contracts, and external profile definitions.
 *
 * @module
 */

import type { Logger } from '@logtape/logtape'

import type { Register } from '../../core/types'

/** Registered resources extracted from module augmentation. */
type RegisteredResources = Register extends { resources: infer R } ? R : {}

/** Specific factor authentication facts recorded during sign-in. */
export type AuthFacts =
  | { readonly method: 'totp' | 'recovery' }
  | { readonly method: 'webauthn'; readonly userVerified: boolean }

/** Application-level identity decoded from a validated session. */
export interface Identity {
  /** Unique subject identifier for the authenticated user. */
  readonly sub: string
  /** Version number of the credentials used to issue this identity. */
  readonly ver: number
  /** Unique JWT token identifier for tracking and revocation. */
  readonly jti: string
  /** Authentication Methods References identifying mechanisms used to authenticate. */
  readonly amr?: readonly string[]
  /** Time of original authentication in Unix seconds (OIDC auth_time). */
  readonly authTime?: number
  /** Application role names assigned to this identity. */
  readonly roles?: readonly string[]
  /** Factor authentication facts recorded during sign-in. */
  readonly auth?: AuthFacts
  /** Custom claims extracted from unreserved JWT payload properties. */
  readonly claims: Readonly<Record<string, unknown>>
}

/** Context passed to token version and validation hooks. */
export type AuthCheckContext<R = RegisteredResources> = {
  /** Application logger instance for security and diagnostic messages. */
  readonly logger: Logger
  /** Optional cancellation signal from client or host shutdown. */
  readonly signal?: AbortSignal
  /** Optional request supplied to the authentication hooks. */
  readonly request?: Request
} & R

/** A single cryptographic signing key in a rotation set. */
export interface SigningKey {
  /** Unique key identifier matching the JWT `kid` header. */
  readonly kid: string
  /** Shared secret key with at least 32 UTF-8 bytes. */
  readonly secret: string
  /** Whether the key has been retired from signing new tokens. */
  readonly retired?: boolean
}

/** Mutually exclusive signing credentials: a single static secret or a rotation keys array. */
export type SigningCredentials =
  | { readonly secret: string; readonly keys?: never }
  | { readonly keys: readonly SigningKey[]; readonly secret?: never }

/** Normalized user profile returned after successful OAuth authorization and exchange. */
export interface UserProfile {
  /** Provider identifier matching the configured provider id. */
  readonly provider: string
  /** Subject identifier provided by the external identity provider. */
  readonly subject: string
  /** Identity provider issuer identifier, when provided. */
  readonly issuer?: string
  /** Email address reported by the identity provider. */
  readonly email?: string
  /** Whether the email address has been verified by the identity provider. */
  readonly emailVerified?: boolean
  /** Display name of the external account. */
  readonly name?: string
  /** Avatar or profile picture URL. */
  readonly picture?: string
  /** Provider-specific profile and claim payloads. */
  readonly raw: unknown
}

/** Tokens returned by OAuth 2.0 or OIDC token exchange. */
export interface OAuthTokens {
  /** Bearer access token used to call provider APIs. */
  readonly accessToken: string
  /** Optional refresh token for refreshing credentials offline. */
  readonly refreshToken?: string
  /** Expiration timestamp in Unix seconds. */
  readonly expiresAt?: number
  /** Token type identifier; usually 'Bearer'. */
  readonly tokenType?: string
  /** Granted scope string. */
  readonly scope?: string
  /** Signed OIDC ID Token string when provided by the identity provider. */
  readonly idToken?: string
}
