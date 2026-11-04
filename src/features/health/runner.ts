/**
 * Health check execution runner with concurrency deduplication, timeouts, and caching.
 *
 * @module
 */

import { getLogger } from '../../app/logging'
import type { HealthCheck, HealthCheckContext, ResolvedHealthConfig } from './types'

interface CacheEntry {
  readonly expiresAt: number
}

/** Runner executing configured readiness checks with concurrency deduplication. */
export interface HealthCheckRunner {
  runReadiness(): Promise<{ ok: boolean; failed: string[] }>
}

export interface HealthRunnerOptions {
  readonly beginWork?: () => void
  readonly endWork?: () => void
  readonly isDraining?: () => boolean
}

/**
 * Creates a health check runner adhering to bounded concurrency, timeout cancellation,
 * and lifecycle work registration.
 *
 * @param config - Resolved and validated health options.
 * @param getResources - Accessor returning active application resources (e.g. db, storage).
 * @param options - Lifecycle coordination hooks.
 * @returns Health check runner.
 */
export function createHealthCheckRunner(
  config: ResolvedHealthConfig,
  getResources: () => Record<string, unknown>,
  options: HealthRunnerOptions = {},
): HealthCheckRunner {
  const readiness = config.readiness
  const timeoutMs = config.timeout
  const cacheMs = config.cache
  const logger = getLogger('health')

  const cache = new Map<string, CacheEntry>()
  const inFlight = new Map<string, Promise<boolean>>()

  async function executeSingleCheck(name: string, check: HealthCheck): Promise<boolean> {
    const now = Date.now()
    const cached = cache.get(name)
    if (cached && now < cached.expiresAt) {
      return true
    }

    const existing = inFlight.get(name)
    if (existing) {
      return existing
    }

    const abortController = new AbortController()
    let timer: NodeJS.Timeout | undefined

    options.beginWork?.()

    const checkPromise = (async () => {
      const resources = getResources()
      const ctx: HealthCheckContext = {
        signal: abortController.signal,
        logger,
        ...resources,
      }
      return check(ctx)
    })()

    const executionPromise = (async () => {
      try {
        const timeoutPromise = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            abortController.abort()
            reject(new Error(`Health check "${name}" timed out after ${timeoutMs}ms`))
          }, timeoutMs)
        })

        await Promise.race([checkPromise, timeoutPromise])
        if (timer) clearTimeout(timer)
        cache.set(name, { expiresAt: Date.now() + cacheMs })
        return true
      } catch (err) {
        if (timer) clearTimeout(timer)
        cache.delete(name)
        logger.error('Health check "{check}" failed: {error}', { check: name, error: err })
        return false
      }
    })()

    // Keep in-flight until the underlying work actually finishes, avoiding query stampede on timeout
    checkPromise
      .catch(() => {})
      .finally(() => {
        inFlight.delete(name)
        options.endWork?.()
      })

    inFlight.set(name, executionPromise)
    return executionPromise
  }

  return {
    async runReadiness(): Promise<{ ok: boolean; failed: string[] }> {
      if (options.isDraining?.()) {
        return { ok: false, failed: ['application_draining'] }
      }

      const names = Object.keys(readiness)
      if (names.length === 0) {
        return { ok: true, failed: [] }
      }

      const results = await Promise.all(
        names.map(async (name) => {
          const ok = await executeSingleCheck(name, readiness[name]!)
          return { name, ok }
        }),
      )

      if (options.isDraining?.()) {
        return { ok: false, failed: ['application_draining'] }
      }

      const failed = results.filter((r) => !r.ok).map((r) => r.name)
      return { ok: failed.length === 0, failed }
    },
  }
}
