/**
 * Rate limiting declaration and middleware exports.
 *
 * @module
 */

export { defineRateLimit } from '../../services/rate-limit/declaration'
export { rateLimit } from '../../services/rate-limit/middleware'
export type {
  CloudflareRateLimitConfig,
  NodeRateLimitConfig,
  RateLimitConfig,
  RateLimitDeclaration,
  RateLimitKey,
} from '../../services/rate-limit/types'
