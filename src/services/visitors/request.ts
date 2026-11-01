/**
 * Request-level visitor state, concurrent ensure deduplication, and cookie serialization.
 *
 * @module
 */

import type { Context } from 'hono'
import { generateSignedCookie, getSignedCookie } from 'hono/cookie'
import { serialize } from 'hono/utils/cookie'

import { VisitorError } from './error'
import type { RequestVisitor, ResolvedVisitorsConfig } from './types'

/** Shared visitor state across the outer request and nested internal calls. */
export interface RequestVisitorState {
  id: string | null
  pendingEnsure?: Promise<string>
  cookieModified?: boolean
  readonly endpointPath: string
}

/** Execution context supplied to initialize per-request visitor identity. */
export interface RequestVisitorContext {
  readonly ctx: Context
  readonly parentState?: RequestVisitorState
  readonly appendCookie: (cookie: string) => void
  readonly isHeadersCommitted: () => boolean
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * Initializes visitor state, verifying an existing cookie once per outer request.
 * Internal calls inherit the same state without repeating verification.
 *
 * @param config - Resolved visitors configuration.
 * @param context - Execution context and cookie forwarders.
 * @returns State and visitor service instance bound to the request.
 */
export async function initRequestVisitor(
  config: ResolvedVisitorsConfig,
  context: RequestVisitorContext,
): Promise<{ state: RequestVisitorState; visitor: RequestVisitor }> {
  const { ctx, parentState, appendCookie, isHeadersCommitted } = context

  let state: RequestVisitorState
  if (parentState) {
    state = parentState
  } else {
    let initialId: string | null = null
    const rawCookie = await getSignedCookie(ctx, config.secret, config.cookieName)
    if (typeof rawCookie === 'string') {
      const parts = rawCookie.split(':')
      if (parts.length === 3 && parts[0] === 'v1') {
        const candidateId = parts[1]
        const exp = Number(parts[2])
        if (UUID_REGEX.test(candidateId) && Number.isSafeInteger(exp) && Date.now() < exp) {
          initialId = candidateId
        }
      }
    }
    state = { id: initialId, endpointPath: config.path }
  }

  const visitor: RequestVisitor = {
    get id() {
      return state.id
    },

    async ensure(): Promise<string> {
      if (state.id !== null) {
        return state.id
      }

      if (state.pendingEnsure) {
        return state.pendingEnsure
      }

      state.pendingEnsure = (async () => {
        try {
          if (isHeadersCommitted()) {
            throw new VisitorError(
              'Cannot write visitor cookie after response headers have been committed.',
              'response_committed',
            )
          }

          const newId = crypto.randomUUID()
          const expiresAt = Date.now() + config.expiresIn
          const payload = `v1:${newId}:${expiresAt}`

          const setCookieVal = await generateSignedCookie(
            config.cookieName,
            payload,
            config.secret,
            {
              ...config.cookie,
              maxAge: Math.floor(config.expiresIn / 1000),
            },
          )

          if (isHeadersCommitted()) {
            throw new VisitorError(
              'Cannot write visitor cookie after response headers have been committed.',
              'response_committed',
            )
          }

          appendCookie(setCookieVal)
          state.id = newId
          state.cookieModified = true
          return newId
        } finally {
          state.pendingEnsure = undefined
        }
      })()

      return state.pendingEnsure
    },

    async clear(): Promise<void> {
      if (isHeadersCommitted()) {
        throw new VisitorError(
          'Cannot clear visitor cookie after response headers have been committed.',
          'response_committed',
        )
      }

      const clearCookieVal = serialize(config.cookieName, '', {
        ...config.cookie,
        maxAge: 0,
        expires: new Date(0),
      })

      appendCookie(clearCookieVal)
      state.id = null
      state.cookieModified = true
    },
  }

  return { state, visitor }
}
