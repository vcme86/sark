/**
 * OAuth transaction state management and cryptographic cookie handling.
 *
 * @module
 */

import { parseSigned, serialize, serializeSigned } from 'hono/utils/cookie'
import * as oidc from 'openid-client'

import type { ResolvedOAuthProvider } from './types'

/** Prefix applied to transaction state cookies. */
export const STATE_COOKIE_PREFIX = '__sark_oauth_'

/** Lifetime of transaction state cookie in seconds (10 minutes). */
export const STATE_MAX_AGE_SECONDS = 600

/** Payload stored inside signed OAuth transaction state cookie. */
export interface OAuthTransactionState {
  readonly purpose: 'oauth'
  readonly id: string
  readonly state: string
  readonly codeVerifier?: string
  readonly codeChallenge?: string
  readonly nonce?: string
  readonly redirectUri: string
  readonly createdAt: number
  readonly expiresAt: number
}

/**
 * Creates cryptographic state, PKCE verifier/challenge, and OIDC nonce for an authorization transaction.
 *
 * @param provider - Owning resolved OAuth provider.
 * @returns Fully constructed transaction state.
 */
export async function createTransactionState(
  provider: ResolvedOAuthProvider,
): Promise<OAuthTransactionState> {
  const state = oidc.randomState()
  const codeVerifier = provider.pkce ? oidc.randomPKCECodeVerifier() : undefined
  const codeChallenge = codeVerifier
    ? await oidc.calculatePKCECodeChallenge(codeVerifier)
    : undefined

  const nonce = provider.protocol === 'oidc' ? oidc.randomNonce() : undefined

  const createdAt = Date.now()
  return {
    purpose: 'oauth',
    id: provider.id,
    state,
    codeVerifier,
    codeChallenge,
    nonce,
    redirectUri: provider.redirectUri,
    createdAt,
    expiresAt: createdAt + STATE_MAX_AGE_SECONDS * 1000,
  }
}

/**
 * Serializes and cryptographically signs transaction state into a Set-Cookie header string.
 * Uses the public callback's resolved Cookie Path, covering both slash variants.
 *
 * @param provider - Owning resolved OAuth provider.
 * @param state - Transaction state to serialize.
 * @param secret - Cookie signing secret with at least 16 characters.
 * @param isProduction - Whether production mode is active.
 * @returns Signed Set-Cookie header string.
 */
export async function createTransactionCookie(
  provider: ResolvedOAuthProvider,
  state: OAuthTransactionState,
  secret: string,
  isProduction: boolean,
): Promise<string> {
  const cookieName = `${STATE_COOKIE_PREFIX}${provider.id}`
  const cookiePath = provider.cookiePath
  const isApple = provider.kind === 'apple'
  const sameSite = isApple ? 'None' : 'Lax'
  const secure = isApple ? true : isProduction

  return serializeSigned(cookieName, JSON.stringify(state), secret, {
    path: cookiePath,
    httpOnly: true,
    secure,
    sameSite,
    maxAge: STATE_MAX_AGE_SECONDS,
  })
}

/**
 * Creates a Set-Cookie header string that clears the transaction state cookie.
 * Uses the same resolved public Cookie Path as transaction creation.
 *
 * @param provider - Owning resolved OAuth provider.
 * @returns Clearing Set-Cookie header string.
 */
export function createClearTransactionCookie(provider: ResolvedOAuthProvider): string {
  const cookieName = `${STATE_COOKIE_PREFIX}${provider.id}`
  const cookiePath = provider.cookiePath
  return serialize(cookieName, '', {
    path: cookiePath,
    httpOnly: true,
    maxAge: 0,
  })
}

/**
 * Parses and verifies an incoming transaction state cookie.
 *
 * @param cookieHeader - Raw Cookie header string from request.
 * @param provider - Owning resolved OAuth provider.
 * @param secret - Cookie signing secret.
 * @returns Verified transaction state.
 * @throws If cookie is missing, tampered, expired, or belongs to a different provider.
 */
export async function verifyTransactionState(
  cookieHeader: string | undefined,
  provider: ResolvedOAuthProvider,
  secret: string,
): Promise<OAuthTransactionState> {
  if (!cookieHeader) {
    throw new Error('Missing OAuth state cookie.')
  }

  const cookieName = `${STATE_COOKIE_PREFIX}${provider.id}`
  let parsedCookie: Record<string, string | false>
  try {
    parsedCookie = await parseSigned(cookieHeader, secret, cookieName)
  } catch {
    throw new Error('Invalid signature on OAuth state cookie.')
  }

  const rawCookieVal = parsedCookie[cookieName]
  if (typeof rawCookieVal !== 'string') {
    throw new Error('Invalid or expired OAuth state cookie.')
  }

  let txData: OAuthTransactionState
  try {
    txData = JSON.parse(rawCookieVal)
  } catch {
    throw new Error('Corrupted OAuth state cookie.')
  }

  if (
    txData.purpose !== 'oauth' ||
    txData.id !== provider.id ||
    txData.redirectUri !== provider.redirectUri
  ) {
    throw new Error('State cookie provider mismatch.')
  }

  if (
    !Number.isFinite(txData.expiresAt) ||
    Date.now() >= txData.expiresAt ||
    txData.createdAt > Date.now()
  ) {
    throw new Error('OAuth transaction state expired.')
  }

  return txData
}
