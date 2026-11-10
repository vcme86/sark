/**
 * Request-level authentication state, explicit sign-in/out actions, and session auto-renewal.
 *
 * @module
 */

import { parse, serialize } from 'hono/utils/cookie'

import type { Identity } from '../contracts'
import type { ResolvedAuthConfig } from './config'
import type { InternalAuthService } from './service'
import type { RequestAuth } from './types'

/** Shared auth session state across outer request and nested internal calls. */
export interface RequestAuthSessionState {
  identity: Identity | null
  isBearer: boolean
  cookieIat?: number
  cookieExp?: number
  action: 'none' | 'signed_in' | 'signed_out'
  renewalApplied: boolean
}

/** Parameters supplied to initialize request-scoped authentication session. */
interface RequestSessionContext {
  readonly request: Request
  readonly signal: AbortSignal
  readonly parentSessionState?: RequestAuthSessionState
  readonly appendCookie: (cookie: string) => void
  readonly isHeadersCommitted: () => boolean
}

/** Handlers returned from request session initialization. */
interface RequestSessionInitResult {
  readonly sessionState: RequestAuthSessionState
  readonly requestAuth: RequestAuth
  readonly onCommitHeaders: () => Promise<void>
}

/** Extracted credential representation from request headers. */
interface ExtractedCredentials {
  readonly token: string
  readonly isBearer: boolean
}

/**
 * Extracts authentication credentials from an incoming Request.
 * Prioritizes Authorization: Bearer <token>. If Authorization header exists but is not Bearer,
 * returns null without falling back to cookie. Otherwise checks Cookie: <cookieName>=<token>.
 *
 * @param request - Incoming HTTP request.
 * @param cookieName - Expected session cookie name.
 * @returns Extracted token and transport kind, or null.
 */
export function extractCredentials(
  request: Request,
  cookieName: string,
): ExtractedCredentials | null {
  const authHeader = request.headers.get('authorization')
  if (authHeader) {
    const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim())
    if (match) {
      return { token: match[1], isBearer: true }
    }
    return null
  }

  const cookieHeader = request.headers.get('cookie')
  if (cookieHeader) {
    const parsed = parse(cookieHeader, cookieName)
    const token = parsed[cookieName]
    if (token) {
      return { token, isBearer: false }
    }
  }

  return null
}

/**
 * Formats a Set-Cookie header value consuming resolved cookie options directly.
 *
 * @param name - Cookie name.
 * @param value - Cookie payload (empty string for deletion).
 * @param cookie - Resolved cookie configuration.
 * @param maxAgeSeconds - Max-Age in seconds (0 for deletion).
 * @returns Valid Set-Cookie header string.
 */
export function formatSetCookie(
  name: string,
  value: string,
  cookie: ResolvedAuthConfig['cookie'],
  maxAgeSeconds: number,
): string {
  return serialize(name, value, {
    path: cookie.path,
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    sameSite: cookie.sameSite,
    maxAge: maxAgeSeconds,
    domain: cookie.domain,
  })
}

/**
 * Initializes request-scoped auth session state, credential evaluation, and auto-renewal lifecycle.
 *
 * @param authService - Owning internal auth service instance.
 * @param context - Request-specific execution parameters.
 * @returns Handlers and session state for the request pipeline.
 */
export async function initRequestSession(
  authService: InternalAuthService,
  context: RequestSessionContext,
): Promise<RequestSessionInitResult> {
  const { request, signal, parentSessionState, appendCookie, isHeadersCommitted } = context
  const config = authService.config

  let sessionState: RequestAuthSessionState
  const isInternal = parentSessionState !== undefined

  if (parentSessionState) {
    sessionState = parentSessionState
  } else {
    sessionState = {
      identity: null,
      isBearer: false,
      action: 'none',
      renewalApplied: false,
    }

    const creds = extractCredentials(request, config.cookieName)
    if (creds) {
      const verified = await authService.verifyInternal(creds.token, { request, signal })
      if (verified) {
        sessionState.identity = verified.identity
        sessionState.isBearer = creds.isBearer
        sessionState.cookieIat = verified.iat
        sessionState.cookieExp = verified.exp
      }
    }
  }

  const requestAuth: RequestAuth = {
    get identity() {
      return sessionState.identity
    },
    signIn: async (input, signInOptions) => {
      if (isHeadersCommitted()) {
        throw new Error('Cannot modify auth session after response headers have been committed.')
      }
      const { expiresAt, ...issued } = await authService.issue(input)
      sessionState.identity = issued.identity
      sessionState.action = 'signed_in'
      if (signInOptions?.cookie !== false) {
        const setCookieVal = formatSetCookie(
          config.cookieName,
          issued.token,
          config.cookie,
          Math.max(0, Math.floor(expiresAt - Date.now() / 1000)),
        )
        appendCookie(setCookieVal)
      }
      return issued
    },
    signOut: async () => {
      if (isHeadersCommitted()) {
        throw new Error('Cannot modify auth session after response headers have been committed.')
      }
      sessionState.identity = null
      sessionState.action = 'signed_out'
      const clearCookieVal = formatSetCookie(config.cookieName, '', config.cookie, 0)
      appendCookie(clearCookieVal)
    },
  }

  const performAutoRenewal = async () => {
    if (isInternal) return
    if (isHeadersCommitted()) return
    if (sessionState.action !== 'none' || sessionState.renewalApplied) return
    if (sessionState.isBearer || !sessionState.identity) return
    sessionState.renewalApplied = true
    const { cookieExp: exp, cookieIat: issuedAt } = sessionState
    if (exp !== undefined && issuedAt !== undefined) {
      const now = Date.now()
      const remainingMs = exp * 1000 - now
      const thresholdMs = config.expiresIn / 2
      if (remainingMs > 0 && remainingMs <= thresholdMs) {
        const renewed = await authService.renew(sessionState.identity, issuedAt, exp)
        // A sign-in or sign-out may complete while the asynchronous signer is running.
        if (!renewed || sessionState.action !== 'none') return
        const setCookieVal = formatSetCookie(
          config.cookieName,
          renewed.token,
          config.cookie,
          Math.max(0, Math.floor(renewed.expiresAt - Date.now() / 1000)),
        )
        appendCookie(setCookieVal)
      }
    }
  }

  return {
    sessionState,
    requestAuth,
    onCommitHeaders: performAutoRenewal,
  }
}
