import type { Context, MiddlewareHandler, Next } from 'hono'
import { csrf as honoCsrf } from 'hono/csrf'
import { HTTPException } from 'hono/http-exception'

import { getCurrentScope } from '../../../core/context'
import { HttpError } from '../error'

export interface CsrfOptions {
  origins?: string[]
}

/**
 * Applies Hono CSRF checks with same-origin and explicitly allowed additional origins.
 * Internal dispatch bypasses the check. Business errors from downstream middleware
 * are not converted into CSRF errors.
 *
 * @param options - False disables checking; true/omission uses the default policy;
 *   an origins array allows additional origins.
 * @returns Middleware that throws HttpError (403, csrf_forbidden) on origin rejection
 *   and bypasses checks for internal dispatch.
 */
export function csrf(options?: CsrfOptions | boolean): MiddlewareHandler {
  if (options === false) {
    return async (_ctx: Context, next: Next) => next()
  }

  const additionalOrigins =
    typeof options === 'object' && Array.isArray(options?.origins) ? options.origins : []

  const upstreamCsrf = honoCsrf({
    origin: (origin: string, c: Context) => {
      if (!origin) return false
      const currentOrigin = getCurrentScope()?.externalOrigin || new URL(c.req.url).origin
      if (origin === currentOrigin) return true
      return additionalOrigins.includes(origin)
    },
  })

  return async (ctx: Context, next: Next) => {
    const scope = getCurrentScope()
    if (
      scope?.isInternal ||
      Object.values(scope?.serviceBindings ?? {}).some((binding) => binding.csrfExempt)
    )
      return next()
    try {
      await upstreamCsrf(ctx, async () => {})
    } catch (err) {
      if (err instanceof HTTPException && err.status === 403) {
        throw new HttpError(403, 'Forbidden by CSRF protection', { code: 'csrf_forbidden' })
      }
      throw err
    }

    return next()
  }
}
