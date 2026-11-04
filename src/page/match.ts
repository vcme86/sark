/**
 * Pure isomorphic route pattern matching.
 *
 * Safe to import in both browser and server environments.
 *
 * @module
 */

/**
 * Matches a route pattern against an incoming URL pathname, extracting named and wildcard parameters.
 *
 * @param pattern - URL pattern (e.g. `/posts/:id` or `/files/*`).
 * @param pathname - Request pathname to test.
 * @param paramNames - Ordered route parameter names, including the wildcard name when present.
 * @param caseSensitive - Whether static segments require exact casing; defaults to true.
 * @returns Decoded parameters (wildcards are arrays), or null for a mismatch or invalid encoding.
 */
export function matchPattern(
  pattern: string,
  pathname: string,
  paramNames: readonly string[],
  caseSensitive = true,
): Record<string, string | string[]> | null {
  if (pattern === pathname && paramNames.length === 0) return {}
  return matchSegments(pattern, splitPath(pathname), paramNames, caseSensitive)
}

function splitPath(pathname: string): string[] {
  const path = pathname.replace(/^\//, '').replace(/\/$/, '')
  return path ? path.split('/') : []
}

/** Path metadata shared by server and browser route matching. */
interface MatchableRoute {
  readonly pattern: string
  readonly paramNames: readonly string[]
}

/**
 * Matches an incoming URL pathname against an array of routes in priority order.
 *
 * @param routes - Registered routes satisfying minimal pattern requirements.
 * @param pathname - Request pathname to test.
 * @param caseSensitive - Whether static segments require exact casing; defaults to true.
 * @returns Matched route and extracted parameters, or null if none matched.
 */
export function matchClientRoute<T extends MatchableRoute>(
  routes: readonly T[],
  pathname: string,
  caseSensitive = true,
): { route: T; params: Record<string, string | string[]> } | null {
  let pathSegments: readonly string[] | undefined
  for (const route of routes) {
    if (route.pattern === pathname && route.paramNames.length === 0) {
      return { route, params: {} }
    }
    const params = matchSegments(
      route.pattern,
      (pathSegments ??= splitPath(pathname)),
      route.paramNames,
      caseSensitive,
    )
    if (params !== null) return { route, params }
  }
  return null
}

function matchSegments(
  pattern: string,
  pathSegments: readonly string[],
  paramNames: readonly string[],
  caseSensitive: boolean,
): Record<string, string | string[]> | null {
  const patternSegments = splitPath(pattern)

  const hasWildcard = patternSegments[patternSegments.length - 1] === '*'
  if (!hasWildcard && patternSegments.length !== pathSegments.length) {
    return null
  }
  if (hasWildcard && pathSegments.length < patternSegments.length - 1) {
    return null
  }

  const params: Record<string, string | string[]> = {}
  for (let i = 0; i < patternSegments.length; i++) {
    const pat = patternSegments[i]
    if (pat === '*') {
      const wildcardName = paramNames[paramNames.length - 1]
      if (wildcardName) {
        try {
          params[wildcardName] = pathSegments.slice(i).map(decodeURIComponent)
        } catch {
          return null
        }
      }
      return params
    }
    if (pat.startsWith(':')) {
      const paramName = pat.slice(1)
      const val = pathSegments[i]
      if (!val) return null
      try {
        params[paramName] = decodeURIComponent(val)
      } catch {
        return null
      }
    } else {
      let value: string
      try {
        value = decodeURIComponent(pathSegments[i])
      } catch {
        return null
      }
      if (caseSensitive ? pat !== value : pat.toLowerCase() !== value.toLowerCase()) return null
    }
  }

  return params
}
