/** URL policies shared by HTTP redirects and browser navigation. */
export interface UrlPolicy {
  readonly caseSensitive: boolean
  readonly trailingSlash: 'never' | 'always' | 'ignore'
}

/**
 * Validates a static endpoint path and normalizes duplicate and trailing slashes.
 *
 * @param path - Absolute pathname without query, fragment, or router pattern syntax.
 * @param field - Configuration field used in diagnostics.
 * @returns A static pathname, preserving the root path.
 * @throws If the path cannot identify a static endpoint.
 */
export function resolveStaticPath(path: string, field: string): string {
  if (
    typeof path !== 'string' ||
    !path.startsWith('/') ||
    path.startsWith('//') ||
    /[\s?#\\:*]/.test(path) ||
    path.split('/').some((segment) => segment === '.' || segment === '..')
  ) {
    throw new Error(`${field} must be an absolute static path without query or fragment.`)
  }
  return path.replace(/\/+/g, '/').replace(/\/$/, '') || '/'
}

/**
 * Restores static route spelling without changing encoded parameter values.
 *
 * @param pathname - Incoming encoded pathname.
 * @param pattern - Matched route pattern with canonical static segments.
 * @returns Pathname retaining the original parameter and wildcard segments.
 */
export function canonicalPathname(pathname: string, pattern: string): string {
  const segments = pattern.split('/')
  return pathname
    .split('/')
    .map((part, index) => {
      const segment = segments[index]
      return segment === undefined || segment === '*' || segment.startsWith(':') ? part : segment
    })
    .join('/')
}

/**
 * Applies the slash policy through URL serialization, preserving origin, query, and hash.
 *
 * @param url - Original URL, which is not mutated.
 * @param pathname - Canonical route pathname before applying the slash policy.
 * @param trailingSlash - Resolved trailing-slash policy; the root path is unchanged.
 * @returns A new URL containing the normalized pathname.
 */
export function normalizeUrlPath(
  url: URL,
  pathname: string,
  trailingSlash: UrlPolicy['trailingSlash'],
): URL {
  if (trailingSlash === 'ignore' && url.pathname.endsWith('/') && !pathname.endsWith('/'))
    pathname += '/'
  if (trailingSlash === 'never' && pathname.length > 1) pathname = pathname.replace(/\/$/, '')
  else if (trailingSlash === 'always' && !pathname.endsWith('/')) pathname += '/'
  const result = new URL(url)
  result.pathname = pathname
  return result
}
