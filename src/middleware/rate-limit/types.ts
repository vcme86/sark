/**
 * Rate limiting configuration and declaration contracts.
 *
 * @module
 */

import type { BaseDeclaration } from '../../app/declaration'
import type { Context } from '../../app/http/types'

/** Custom key resolver extracting a partition identity from the request context. */
export type RateLimitKey = (ctx: Context) => string | Promise<string>

/** Node.js in-memory bounded fixed-window rate limit configuration. */
export interface NodeRateLimitConfig {
  /** Window duration in milliseconds (positive number). */
  window: number
  /** Maximum allowed requests within the window (positive integer). */
  limit: number
  /** Whether to emit RateLimit-* and Retry-After headers (defaults to true). */
  headers?: boolean
  /** Custom key extractor; defaults to client IP. */
  key?: RateLimitKey
  /** Maximum number of partition keys retained in memory before eviction. Defaults to 50,000. */
  maxKeys?: number
  binding?: never
}

/** Cloudflare Workers platform rate limiter binding configuration. */
export interface CloudflareRateLimitConfig {
  /** Name of the Rate Limiting binding in the Worker environment. */
  binding: string
  /** Custom key extractor; defaults to client IP. */
  key?: RateLimitKey
  window?: never
  limit?: never
  headers?: never
  maxKeys?: never
}

/** Configuration for application or route rate limiting. */
export type RateLimitConfig = NodeRateLimitConfig | CloudflareRateLimitConfig

/** Declaration representing application-level rate limiting. */
export type RateLimitDeclaration = BaseDeclaration<'rate_limit', RateLimitConfig>

/** Resolved and validated Node.js rate limit configuration. */
export interface ResolvedNodeRateLimitConfig {
  readonly kind: 'node'
  readonly window: number
  readonly limit: number
  readonly headers: boolean
  readonly key?: RateLimitKey
  readonly maxKeys: number
}

/** Resolved and validated Cloudflare Workers rate limit configuration. */
export interface ResolvedCloudflareRateLimitConfig {
  readonly kind: 'cloudflare'
  readonly binding: string
  readonly key?: RateLimitKey
}

/** Resolved and validated rate limiting configuration contract. */
export type ResolvedRateLimitConfig =
  | ResolvedNodeRateLimitConfig
  | ResolvedCloudflareRateLimitConfig
