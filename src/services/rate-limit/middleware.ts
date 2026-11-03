/**
 * HTTP rate limiting middleware factory.
 *
 * @module
 */

import { getCurrentScope } from '../../core/context'
import { HttpError } from '../../http/error'
import type { MiddlewareHandler } from '../../http/types'
import { checkCloudflareRateLimit } from './cloudflare'
import { NodeRateLimiter, resolveClientIp } from './node'
import type {
  CloudflareRateLimitConfig,
  NodeRateLimitConfig,
  RateLimitConfig,
  ResolvedRateLimitConfig,
} from './types'

function isNodeConfig(
  options: RateLimitConfig | ResolvedRateLimitConfig,
): options is
  | NodeRateLimitConfig
  | { kind: 'node'; window: number; limit: number; headers: boolean; key?: any; maxKeys: number } {
  return (
    ('kind' in options && options.kind === 'node') ||
    typeof (options as NodeRateLimitConfig).window === 'number'
  )
}

/**
 * Creates an independent rate limiting middleware handler.
 * Each invocation constructs a distinct limiter instance with its own state.
 *
 * @param options - Platform-specific rate limit configuration.
 * @returns Sark middleware handler enforcing request throughput limits.
 */
export function rateLimit(options: RateLimitConfig | ResolvedRateLimitConfig): MiddlewareHandler {
  const staticLimiter = isNodeConfig(options)
    ? new NodeRateLimiter(options as NodeRateLimitConfig)
    : undefined

  return async (ctx, next) => {
    const scope = getCurrentScope()
    // Exempt internal calls (SSR, internal fetch) from external entrance quota
    if (scope?.isInternal) {
      return next()
    }

    const key = options.key ? await options.key(ctx) : resolveClientIp(ctx)

    if (isNodeConfig(options)) {
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

    const allowed = await checkCloudflareRateLimit(ctx, options as CloudflareRateLimitConfig, key)
    if (!allowed) {
      throw new HttpError(429, 'Too Many Requests', {
        code: 'rate_limit_exceeded',
      })
    }

    return next()
  }
}
