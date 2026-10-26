/** URL policies shared by HTTP redirects and browser navigation. */
export interface UrlPolicy {
  readonly caseSensitive: boolean
  readonly trailingSlash: 'never' | 'always' | 'ignore'
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
