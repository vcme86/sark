/**
 * Declaration factory for application rate limiting.
 *
 * @module
 */

import { evaluateDeclaration, type RequiresEnv } from '../../app/declaration'
import type { RateLimitConfig, RateLimitDeclaration, ResolvedRateLimitConfig } from './types'

export function defineRateLimit(config: RateLimitConfig): RateLimitDeclaration
export function defineRateLimit<E>(
  factory: (env: E) => RateLimitConfig,
): RateLimitDeclaration & RequiresEnv<E>
export function defineRateLimit<E>(
  input: RateLimitConfig | ((env: E) => RateLimitConfig),
): RateLimitDeclaration {
  return {
    kind: 'rate_limit',
    value: input,
    isFactory: typeof input === 'function',
  }
}

/**
 * Resolves, validates, and normalizes declared rate limiting configuration against host environment.
 *
 * @param declaration - Declared rate limiting configuration or factory.
 * @param env - Current environment.
 * @returns Fully validated and resolved rate limit configuration contract, or undefined if no declaration provided.
 * @throws {Error} If configuration values are invalid or platform options are mixed.
 */
export function resolveRateLimitDeclaration(
  declaration: RateLimitDeclaration | undefined,
  env: unknown,
): ResolvedRateLimitConfig | undefined {
  if (!declaration) return undefined
  const raw = evaluateDeclaration<RateLimitConfig>(declaration.value, env, 'rateLimit')
  return resolveRateLimitConfig(raw)
}

/** Resolves one public rate limit input before creating counters or request handlers. */
export function resolveRateLimitConfig(raw: RateLimitConfig): ResolvedRateLimitConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Rate limit configuration must be an object.')
  }

  if (raw.key !== undefined && typeof raw.key !== 'function')
    throw new Error('Rate limit key must be a function.')

  if ('binding' in raw && raw.binding !== undefined) {
    if (typeof raw.binding !== 'string' || !raw.binding.trim()) {
      throw new Error('Cloudflare rate limit binding must be a non-empty string.')
    }
    if ('window' in raw || 'limit' in raw || 'headers' in raw || 'maxKeys' in raw) {
      throw new Error(
        'Cloudflare rate limit binding cannot be combined with Node-specific rate limit options (window, limit, headers, maxKeys).',
      )
    }
    return {
      kind: 'cloudflare',
      binding: raw.binding.trim(),
      key: raw.key,
    }
  }

  if (raw.window === undefined || raw.limit === undefined) {
    throw new Error(
      'Node rate limit configuration requires both "window" (milliseconds) and "limit" (max requests).',
    )
  }

  if (!Number.isFinite(raw.window) || raw.window <= 0) {
    throw new Error('Node rate limit "window" must be a positive number of milliseconds.')
  }

  if (!Number.isInteger(raw.limit) || raw.limit <= 0) {
    throw new Error('Node rate limit "limit" must be a positive integer.')
  }

  if (raw.headers !== undefined && typeof raw.headers !== 'boolean')
    throw new Error('Rate limit headers must be a boolean.')

  const maxKeys = raw.maxKeys ?? 50_000
  if (!Number.isInteger(maxKeys) || maxKeys <= 0) {
    throw new Error('Node rate limit "maxKeys" must be a positive integer.')
  }

  return {
    kind: 'node',
    window: raw.window,
    limit: raw.limit,
    headers: raw.headers ?? true,
    key: raw.key,
    maxKeys,
  }
}
