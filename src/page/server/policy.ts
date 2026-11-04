import type { Context } from 'hono'

import type { PageCacheConfig, ServerPageScope } from '../types'

/** Inherited response policy; tag declarations remain unevaluated until route parameters are known. */
export interface PageHttpCache extends Pick<
  PageCacheConfig,
  'ttl' | 'staleWhileRevalidate' | 'vary'
> {
  readonly tags?: readonly (
    | readonly string[]
    | ((params: Record<string, string | string[]>) => readonly string[])
  )[]
}

/**
 * Resolves inherited HTTP cache policy without creating storage.
 * false resets inheritance; later fields override earlier fields; vary and tags accumulate.
 *
 * @param scopes - Layout-to-page declarations in inheritance order.
 * @returns Effective HTTP cache fields, or undefined when no declaration remains enabled.
 * @throws {Error} If a declared TTL or stale-while-revalidate duration is negative or non-finite.
 */
export function resolvePageCache(scopes: readonly ServerPageScope[]): PageHttpCache | undefined {
  let current: PageHttpCache | undefined
  for (const scope of scopes) {
    if (scope.cache === false) {
      current = undefined
    } else if (scope.cache !== undefined) {
      const value = scope.cache
      for (const field of ['ttl', 'staleWhileRevalidate'] as const) {
        if (value[field] !== undefined && (!Number.isFinite(value[field]) || value[field]! < 0)) {
          throw new Error(`Page cache ${field} must be a non-negative number.`)
        }
      }
      const existingTags = current?.tags ?? []
      const newTags = value.tags !== undefined ? [...existingTags, value.tags] : existingTags

      current = {
        ...current,
        ttl: value.ttl === undefined ? current?.ttl : value.ttl,
        staleWhileRevalidate:
          value.staleWhileRevalidate === undefined
            ? current?.staleWhileRevalidate
            : value.staleWhileRevalidate,
        tags: newTags.length ? newTags : undefined,
        vary: [...new Set([...(current?.vary ?? []), ...(value.vary ?? [])])],
      }
    }
  }
  return current
}

/**
 * Evaluates declared cache tags with matched route parameters.
 *
 * @param cache - Resolved page cache policy.
 * @param params - Parsed route parameters.
 * @returns Deduplicated list of cache tag strings.
 */
export function resolveCacheTags(
  cache: PageHttpCache | undefined,
  params: Record<string, string | string[]>,
): string[] {
  if (!cache?.tags || cache.tags.length === 0) return []
  const result = new Set<string>()
  for (const item of cache.tags) {
    if (typeof item === 'function') {
      const tags = item(params)
      for (const tag of tags) result.add(tag)
    } else if (Array.isArray(item)) {
      for (const tag of item) result.add(tag)
    }
  }
  return [...result]
}

/**
 * Parses effective TTL and SWR from explicit Cache-Control response headers or declared policy.
 * s-maxage takes precedence over max-age; both override declared ttl.
 *
 * @param cacheControl - Cache-Control header string.
 * @param declaredTtl - Declared page TTL in seconds.
 * @param declaredSwr - Declared stale-while-revalidate in seconds.
 * @returns Resolved freshness and SWR durations in seconds.
 */
export function parseCacheDirectives(
  cacheControl: string | null,
  declaredTtl: number | undefined,
  declaredSwr: number | undefined,
): { ttl: number; staleWhileRevalidate: number } {
  let ttl = declaredTtl ?? 0
  let staleWhileRevalidate = declaredSwr ?? 0

  if (cacheControl) {
    const sMaxAgeMatch = /\bs-maxage=(\d+)\b/i.exec(cacheControl)
    const maxAgeMatch = /\bmax-age=(\d+)\b/i.exec(cacheControl)
    const swrMatch = /\bstale-while-revalidate=(\d+)\b/i.exec(cacheControl)

    if (sMaxAgeMatch?.[1]) {
      ttl = Number.parseInt(sMaxAgeMatch[1], 10)
    } else if (maxAgeMatch?.[1]) {
      ttl = Number.parseInt(maxAgeMatch[1], 10)
    }

    if (swrMatch?.[1]) {
      staleWhileRevalidate = Number.parseInt(swrMatch[1], 10)
    }
  }

  if (/\b(?:must-revalidate|proxy-revalidate)\b/i.test(cacheControl ?? '')) staleWhileRevalidate = 0
  return { ttl, staleWhileRevalidate }
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
