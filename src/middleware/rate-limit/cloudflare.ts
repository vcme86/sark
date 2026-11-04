/**
 * Cloudflare Workers platform limiter binding integration.
 *
 * @module
 */

import type { RateLimit } from '@cloudflare/workers-types'
import type { Context } from 'hono'

import type { ResolvedCloudflareRateLimitConfig } from './types'

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
  config: ResolvedCloudflareRateLimitConfig,
  key: string,
): Promise<boolean> {
  const limiter = ctx.env?.[config.binding] as RateLimit | undefined

  if (!limiter || typeof limiter.limit !== 'function') {
    throw new Error(
      `Rate limiter binding "${config.binding}" not found or invalid in Worker environment.`,
    )
  }

  const { success } = await limiter.limit({ key })
  return success
}
