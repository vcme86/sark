/**
 * HTTP rate limiting middleware factory.
 *
 * @module
 */

import { getCurrentScope } from '../../app/context'
import type { MiddlewareHandler } from '../../app/http/types'
import { HttpError } from '../../http/error'
import { checkCloudflareRateLimit } from './cloudflare'
import { resolveRateLimitConfig } from './declaration'
import { NodeRateLimiter } from './node'
import type { RateLimitConfig, ResolvedRateLimitConfig } from './types'

/**
 * Creates an independent rate limiting middleware handler.
 * Each Node middleware owns an independent counter; Workers use the configured binding.
 *
 * @param options - Platform-specific rate limit configuration.
 * @returns Sark middleware handler enforcing request throughput limits.
 */
export function rateLimit(options: RateLimitConfig): MiddlewareHandler {
  return createRateLimitMiddleware(resolveRateLimitConfig(options))
}

/** Builds a handler from trusted settings, optionally sharing its inherited Node counter. */
export function createRateLimitMiddleware(
  options: ResolvedRateLimitConfig,
  counter?: NodeRateLimiter,
): MiddlewareHandler {
  const staticLimiter =
    options.kind === 'node' ? (counter ?? new NodeRateLimiter(options)) : undefined

  return async (ctx, next) => {
    const scope = getCurrentScope()
    // Exempt internal calls (SSR, internal fetch) from external entrance quota
    if (scope?.isInternal) {
      return next()
    }

    const key = options.key ? await options.key(ctx) : (scope?.clientIp ?? '127.0.0.1')

    if (options.kind === 'node') {
      const res = staticLimiter!.check(key)

      if (options.headers !== false) {
        ctx.header('RateLimit-Limit', String(res.limit))
        ctx.header('RateLimit-Remaining', String(res.remaining))
        ctx.header('RateLimit-Reset', String(res.resetSeconds))
      }

      if (!res.allowed) {
        const headers: Record<string, string> = {}
        if (options.headers !== false) {
          headers['RateLimit-Limit'] = String(res.limit)
          headers['RateLimit-Remaining'] = String(res.remaining)
          headers['RateLimit-Reset'] = String(res.resetSeconds)
          headers['Retry-After'] = String(res.resetSeconds)
        }
        throw new HttpError(429, 'Too Many Requests', {
          code: 'rate_limit_exceeded',
          headers,
        })
      }

      return next()
    }

    const allowed = await checkCloudflareRateLimit(ctx, options, key)
    if (!allowed) {
      throw new HttpError(429, 'Too Many Requests', {
        code: 'rate_limit_exceeded',
      })
    }

    return next()
  }
}
