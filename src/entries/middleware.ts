/**
 * HTTP security and performance middleware.
 *
 * @module
 */

export { cors, type CorsOptions } from '../middleware/cors'
export { csrf, type CsrfOptions } from '../middleware/csrf'
export { compress, type CompressionOptions } from '../middleware/compress'

export { defineRateLimit } from '../middleware/rate-limit/declaration'
export { rateLimit } from '../middleware/rate-limit/middleware'
export type {
  CloudflareRateLimitConfig,
  NodeRateLimitConfig,
  RateLimitConfig,
  RateLimitDeclaration,
  RateLimitKey,
} from '../middleware/rate-limit/types'
