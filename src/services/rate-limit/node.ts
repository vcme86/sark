/**
 * Node.js in-memory bounded fixed-window rate limiter with bounded capacity.
 *
 * @module
 */

import { getCurrentScope } from '../../core/context'
import type { Context } from '../../http/types'
import type { NodeRateLimitConfig } from './types'

interface WindowEntry {
  count: number
  resetAt: number
}

/** Resolves the verified client IP from the current execution scope. */
export function resolveClientIp(_ctx?: Context): string {
  const scope = getCurrentScope()
  if (scope?.clientIp) return scope.clientIp
  return '127.0.0.1'
}

/** In-memory fixed-window rate limiter tracking hit counts per key with bounded capacity. */
export class NodeRateLimiter {
  private readonly entries = new Map<string, WindowEntry>()
  private readonly maxCapacity: number

  constructor(
    readonly config: NodeRateLimitConfig,
    maxCapacity = config.maxKeys ?? 10000,
  ) {
    if (!Number.isFinite(config.window) || config.window <= 0) {
      throw new Error('Rate limit window must be a positive number of milliseconds.')
    }
    if (!Number.isInteger(config.limit) || config.limit <= 0) {
      throw new Error('Rate limit limit must be a positive integer.')
    }
    if (typeof maxCapacity !== 'number' || !Number.isInteger(maxCapacity) || maxCapacity <= 0) {
      throw new Error('Rate limit maxKeys must be a positive integer.')
    }
    this.maxCapacity = maxCapacity
  }

  /** Current number of active keys in the rate limiter cache. */
  get size(): number {
    return this.entries.size
  }

  check(
    key: string,
    now = Date.now(),
  ): {
    allowed: boolean
    limit: number
    remaining: number
    resetSeconds: number
  } {
    let entry = this.entries.get(key)
    if (entry && now >= entry.resetAt) {
      this.entries.delete(key)
      entry = undefined
    }

    if (!entry) {
      if (this.entries.size >= this.maxCapacity) {
        // Incrementally prune expired entries from the head of the insertion-ordered Map
        for (const [k, v] of this.entries.entries()) {
          if (now >= v.resetAt) {
            this.entries.delete(k)
          } else {
            // Older entries are inserted earlier; when the oldest unexpired entry is hit, stop scan
            break
          }
        }
        // If still at capacity after pruning expired head entries, evict the oldest key
        if (this.entries.size >= this.maxCapacity) {
          const oldest = this.entries.keys().next().value
          if (oldest !== undefined) this.entries.delete(oldest)
        }
      }
      entry = { count: 0, resetAt: now + this.config.window }
      this.entries.set(key, entry)
    }

    entry.count += 1
    const remaining = Math.max(0, this.config.limit - entry.count)
    const resetSeconds = Math.max(1, Math.ceil((entry.resetAt - now) / 1000))
    const allowed = entry.count <= this.config.limit

    return {
      allowed,
      limit: this.config.limit,
      remaining,
      resetSeconds,
    }
  }
}
