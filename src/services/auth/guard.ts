/**
 * Step-up authentication guard middleware.
 *
 * @module
 */

import type { Context, MiddlewareHandler, Next } from 'hono'

import { HttpError } from '../../web/http/error'
import type { RequestAuth } from './session/types'

/** Options required to guard sensitive operations with step-up verification. */
export interface StepUpOptions {
  /** Maximum age in milliseconds since the original authentication event. */
  readonly maxAge: number
  /** Specific authentication method references that must all be present in `identity.amr`. */
  readonly amr?: string | readonly string[]
}

/**
 * Creates a route guard requiring recent authentication and optional MFA methods.
 *
 * @param options - Maximum authentication age in milliseconds and required methods.
 * @returns Middleware throwing 403 `step_up_required` when criteria are not satisfied.
 * @throws If maxAge is not a finite, non-negative duration.
 */
export function requireStepUp(options: StepUpOptions): MiddlewareHandler {
  if (
    !options ||
    typeof options.maxAge !== 'number' ||
    !Number.isFinite(options.maxAge) ||
    options.maxAge < 0
  ) {
    throw new Error('requireStepUp requires a non-negative maxAge in milliseconds.')
  }

  return async (ctx: Context, next: Next) => {
    const auth = (ctx.var as { auth?: RequestAuth }).auth
    const identity = auth?.identity
    if (!identity) {
      throw new HttpError(403, 'Step-up authentication required', {
        code: 'step_up_required',
      })
    }

    const authTimeMs = identity.authTime !== undefined ? identity.authTime * 1000 : undefined

    if (authTimeMs === undefined || Date.now() - authTimeMs > options.maxAge) {
      throw new HttpError(403, 'Step-up authentication required: authentication expired', {
        code: 'step_up_required',
      })
    }

    if (options.amr) {
      const requiredMethods = Array.isArray(options.amr) ? options.amr : [options.amr]
      const currentAmr = new Set(identity.amr ?? [])
      for (const requiredMethod of requiredMethods) {
        if (!currentAmr.has(requiredMethod)) {
          throw new HttpError(
            403,
            `Step-up authentication required: missing verification method "${requiredMethod}"`,
            { code: 'step_up_required' },
          )
        }
      }
    }

    return next()
  }
}
