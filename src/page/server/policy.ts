import type { Context } from 'hono'

import type { PageCacheConfig, ServerPageScope } from '../types'

type PageHttpCache = Pick<PageCacheConfig, 'ttl' | 'staleWhileRevalidate' | 'vary'>

/**
 * Resolves inherited HTTP cache policy without creating storage or evaluating tags.
 * false resets inheritance; later fields override earlier fields and vary names accumulate.
 *
 * @param scopes - Layout-to-page declarations in inheritance order.
 * @returns Effective HTTP cache fields, or undefined when no declaration remains enabled.
 * @throws {Error} If a declared TTL or stale-while-revalidate duration is negative or non-finite.
 */
export function resolvePageCache(scopes: readonly ServerPageScope[]): PageHttpCache | undefined {
  let current: PageHttpCache | undefined
  for (const scope of scopes) {
    if (scope.cache === false) current = undefined
    else if (scope.cache !== undefined) {
      const value = scope.cache
      for (const field of ['ttl', 'staleWhileRevalidate'] as const) {
        if (value[field] !== undefined && (!Number.isFinite(value[field]) || value[field]! < 0)) {
          throw new Error(`Page cache ${field} must be a non-negative number.`)
        }
      }
      current = {
        ...current,
        ttl: value.ttl === undefined ? current?.ttl : value.ttl,
        staleWhileRevalidate:
          value.staleWhileRevalidate === undefined
            ? current?.staleWhileRevalidate
            : value.staleWhileRevalidate,
        vary: [...new Set([...(current?.vary ?? []), ...(value.vary ?? [])])],
      }
    }
  }
  return current
}

/**
 * Builds page response headers after loaders and before shell commitment.
 * Credentials, a display user, or outgoing cookies force private, no-store.
 * Otherwise existing cache restrictions are retained and declared Vary fields are merged.
 *
 * @param context - Page request and headers accumulated by middleware and API calls.
 * @param cache - Effective page cache declaration; no storage is initialized here.
 * @param production - Whether public TTL caching is available for this response.
 * @param hasIdentity - Whether the resolved display snapshot contains a user.
 * @returns A new header collection without mutating the context's current headers.
 */
export function pageHeaders(
  context: Context,
  cache: PageHttpCache | undefined,
  production: boolean,
  hasIdentity: boolean,
): Headers {
  const headers = new Headers(context.res.headers)
  if (
    context.req.header('cookie') ||
    context.req.header('authorization') ||
    hasIdentity ||
    headers.has('set-cookie')
  ) {
    headers.set('Cache-Control', 'private, no-store')
  } else if (!headers.has('cache-control')) {
    headers.set(
      'Cache-Control',
      production && cache?.ttl && cache.ttl > 0
        ? `public, max-age=${Math.floor(cache.ttl)}, s-maxage=${Math.floor(cache.ttl)}` +
            (cache.staleWhileRevalidate
              ? `, stale-while-revalidate=${Math.floor(cache.staleWhileRevalidate)}`
              : '')
        : 'no-store',
    )
  }
  if (cache?.vary?.length) {
    const vary = new Set(
      (headers.get('vary') ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    )
    for (const field of cache.vary) vary.add(field)
    headers.set('Vary', [...vary].join(', '))
  }
  return headers
}
