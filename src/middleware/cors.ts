import type { MiddlewareHandler } from 'hono'
import { cors as honoCors } from 'hono/cors'

import { getCurrentScope } from '../app/context'

type UpstreamCorsOptions = NonNullable<Parameters<typeof honoCors>[0]>

/** Hono CORS options with an explicit origin requirement. */
export interface CorsOptions extends Omit<UpstreamCorsOptions, 'origin'> {
  /** Allowed origin(s) or a function resolving allowed origin dynamically from request origin. */
  origin: NonNullable<UpstreamCorsOptions['origin']>
}

/**
 * Creates Cross-Origin Resource Sharing (CORS) middleware.
 * Enforces explicit `origin` configuration as required by `http.md`.
 *
 * @param options - Hono CORS options with an explicit allowed origin policy.
 * @returns Middleware applying CORS to external requests and bypassing internal dispatch.
 * @throws {Error} If origin is missing or empty.
 */
export function cors(options: CorsOptions): MiddlewareHandler {
  if (!options || !options.origin) {
    throw new Error('CORS requires an explicit origin configuration.')
  }
  const upstreamCors = honoCors(options)
  return (ctx, next) => (getCurrentScope()?.isInternal ? next() : upstreamCors(ctx, next))
}
