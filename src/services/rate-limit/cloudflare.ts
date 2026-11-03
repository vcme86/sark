/**
 * Cloudflare Workers platform limiter binding integration.
 *
 * @module
 */

import type { Context } from 'hono'

import { getCurrentScope } from '../../core/context'
import type { CloudflareRateLimitConfig } from './types'

interface PlatformRateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>
}

/**
 * Checks an incoming request against a Cloudflare Workers platform rate limiting binding.
 *
 * @param ctx - Hono request context.
 * @param config - Rate limit binding configuration.
 * @param key - Resolved partition key.
 * @returns True if within quota; false if rejected (429).
 * @throws If the specified binding is missing or does not implement limit().
 */
export async function checkCloudflareRateLimit(
  ctx: Context,
  config: CloudflareRateLimitConfig,
  key: string,
): Promise<boolean> {
  const scope = getCurrentScope()
  const env = ((ctx as any).env ?? scope?.env ?? {}) as Record<string, unknown>
  const limiter = env[config.binding] as PlatformRateLimiter | undefined

  if (!limiter || typeof limiter.limit !== 'function') {
    throw new Error(
      `Rate limiter binding "${config.binding}" not found or invalid in Worker environment.`,
    )
  }

  const result = await limiter.limit({ key })
  return Boolean(result && result.success)
}
