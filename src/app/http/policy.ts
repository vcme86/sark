/**
 * Route-specific and directory scope overrides for application CORS, CSRF and body-limit defaults.
 *
 * @module
 */

import type { CorsOptions } from '../../middleware/cors'
import { assertBodyLimit, type ResolvedHttpConfig } from '../config'
import type { RouteOptions, RouteScope } from './types'

/** Effective CORS, CSRF and body-limit policy for an endpoint. */
export interface EffectivePolicy {
  /** Maximum allowed request body size in bytes, or `false` to disable limit. */
  readonly bodyLimit: number | false
  /** Route-specific CORS options, or `false` if disabled. */
  readonly cors: false | CorsOptions
  /** Route-specific CSRF configuration, or `false` if disabled. */
  readonly csrf: boolean | { origins?: string[] }
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
 * @returns Fully resolved effective policy.
 */
export function computeEffectivePolicy(
  appConfig: ResolvedHttpConfig,
  routeOptions: Pick<RouteOptions, 'bodyLimit' | 'cors' | 'csrf'> = {},
  scopes: readonly RouteScope[] = [],
): EffectivePolicy {
  let policy: EffectivePolicy = {
    bodyLimit: appConfig.bodyLimit,
    cors: appConfig.cors,
    csrf: appConfig.csrf,
  }
  for (const scope of scopes) {
    if (scope.options) policy = applyOverrides(policy, scope.options)
  }
  return applyOverrides(policy, routeOptions)
}

function applyOverrides(
  parent: EffectivePolicy,
  input: Pick<RouteOptions, 'bodyLimit' | 'cors' | 'csrf'>,
): EffectivePolicy {
  for (const field of ['cors', 'csrf', 'bodyLimit'] as const) {
    if (input[field] === null) throw new Error(`Route policy ${field} does not accept null.`)
  }
  if (input.bodyLimit !== undefined) assertBodyLimit(input.bodyLimit)
  return {
    bodyLimit: input.bodyLimit === undefined ? parent.bodyLimit : input.bodyLimit,
    cors: input.cors === undefined ? parent.cors : input.cors,
    csrf: input.csrf === undefined ? parent.csrf : input.csrf,
  }
}
