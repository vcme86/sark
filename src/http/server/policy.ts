/**
 * Route-specific and directory scope overrides for application CORS, CSRF, body-limit, and rate-limit defaults.
 *
 * @module
 */

import type { RateLimitConfig } from '../../services/rate-limit/types'
import { assertBodyLimit, type CorsOptions, type ResolvedHttpConfig } from '../config'
import type { RouteOptions, RouteScope } from '../types'

/** Effective CORS, CSRF, body-limit, and rate-limit policy for an endpoint. */
export interface EffectivePolicy {
  /** Maximum allowed request body size in bytes, or `false` to disable limit. */
  readonly bodyLimit: number | false
  /** Route-specific CORS options, or `false` if disabled. */
  readonly cors: false | CorsOptions
  /** Route-specific CSRF configuration, or `false` if disabled. */
  readonly csrf: boolean | { origins?: string[] }
  /** Effective rate limiting options, or `false` if disabled. */
  readonly rateLimit?: false | RateLimitConfig | ((env: unknown) => RateLimitConfig)
}

/**
 * Applies directory scopes and route overrides over application defaults, preserving explicit false values.
 *
 * Policy precedence, highest first:
 * 1. Explicit route option.
 * 2. Nearest ancestor scope defining that policy, then more distant ancestors.
 * 3. Already resolved application policy; no framework defaults are added here.
 *
 * @param appConfig - Already resolved application HTTP configuration.
 * @param routeOptions - Route-specific override options.
 * @param scopes - Ordered list of ancestor directory scopes (from root down to closest directory).
 * @param baseRateLimit - Application-level rate limit configuration, if declared.
 * @returns Fully resolved effective policy.
 */
export function computeEffectivePolicy(
  appConfig: ResolvedHttpConfig,
  routeOptions: Pick<RouteOptions, 'bodyLimit' | 'cors' | 'csrf' | 'rateLimit'> = {},
  scopes: readonly RouteScope[] = [],
  baseRateLimit?: RateLimitConfig | ((env: unknown) => RateLimitConfig),
): EffectivePolicy {
  const hasLocalRateLimit =
    (routeOptions.rateLimit !== undefined && routeOptions.rateLimit !== false) ||
    scopes.some(
      (scope) => scope.options?.rateLimit !== undefined && scope.options.rateLimit !== false,
    )

  if (hasLocalRateLimit && !baseRateLimit) {
    throw new Error('Cannot declare route/scope rateLimit without application defineRateLimit.')
  }

  let effectiveRateLimit:
    | false
    | RateLimitConfig
    | ((env: unknown) => RateLimitConfig)
    | undefined = baseRateLimit

  let policy: EffectivePolicy = {
    bodyLimit: appConfig.bodyLimit,
    cors: appConfig.cors,
    csrf: appConfig.csrf,
    rateLimit: effectiveRateLimit,
  }

  for (const scope of scopes) {
    if (scope.options) {
      policy = applyOverrides(policy, scope.options)
      if (scope.options.rateLimit !== undefined) {
        if (scope.options.rateLimit === false) {
          effectiveRateLimit = false
        } else if (typeof (effectiveRateLimit || baseRateLimit) === 'function') {
          const prevFn = (effectiveRateLimit || baseRateLimit) as (env: unknown) => RateLimitConfig
          const overrides = scope.options.rateLimit
          effectiveRateLimit = (env: unknown) =>
            ({
              ...prevFn(env),
              ...overrides,
            }) as RateLimitConfig
        } else if (typeof (effectiveRateLimit || baseRateLimit) === 'object') {
          effectiveRateLimit = {
            ...((effectiveRateLimit || baseRateLimit) as object),
            ...scope.options.rateLimit,
          } as RateLimitConfig
        } else {
          effectiveRateLimit = scope.options.rateLimit as RateLimitConfig
        }
      }
    }
  }

  const finalPolicy = applyOverrides(policy, routeOptions)
  if (routeOptions.rateLimit !== undefined) {
    if (routeOptions.rateLimit === false) {
      effectiveRateLimit = false
    } else if (typeof (effectiveRateLimit || baseRateLimit) === 'function') {
      const prevFn = (effectiveRateLimit || baseRateLimit) as (env: unknown) => RateLimitConfig
      const overrides = routeOptions.rateLimit
      effectiveRateLimit = (env: unknown) =>
        ({
          ...prevFn(env),
          ...overrides,
        }) as RateLimitConfig
    } else if (typeof (effectiveRateLimit || baseRateLimit) === 'object') {
      effectiveRateLimit = {
        ...((effectiveRateLimit || baseRateLimit) as object),
        ...routeOptions.rateLimit,
      } as RateLimitConfig
    } else {
      effectiveRateLimit = routeOptions.rateLimit as RateLimitConfig
    }
  }

  return {
    ...finalPolicy,
    rateLimit: effectiveRateLimit,
  }
}

function applyOverrides(
  parent: EffectivePolicy,
  input: Pick<RouteOptions, 'bodyLimit' | 'cors' | 'csrf' | 'rateLimit'>,
): EffectivePolicy {
  for (const field of ['cors', 'csrf', 'bodyLimit'] as const) {
    if (input[field] === null) throw new Error(`Route policy ${field} does not accept null.`)
  }
  if (input.bodyLimit !== undefined) assertBodyLimit(input.bodyLimit)
  return {
    bodyLimit: input.bodyLimit === undefined ? parent.bodyLimit : input.bodyLimit,
    cors: input.cors === undefined ? parent.cors : input.cors,
    csrf: input.csrf === undefined ? parent.csrf : input.csrf,
    rateLimit: parent.rateLimit,
  }
}
