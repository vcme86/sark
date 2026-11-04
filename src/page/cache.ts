/** Public page cache declarations and application-scoped invalidation helpers. */

import { getCurrentScope } from '../app/context'
import { type BaseDeclaration, evaluateDeclaration, type RequiresEnv } from '../app/declaration'

/** Capacity and fallback freshness for optional public page storage. */
export interface PageCacheOptions {
  /** Maximum number of entries in the LRU cache. Defaults to 500. */
  readonly maxEntries?: number
  /** Maximum total byte size of cached response bodies. Defaults to 31457280 (30 MiB). */
  readonly maxBytes?: number
  /** Maximum body byte size for a single cache entry. Defaults to 4194304 (4 MiB). */
  readonly maxEntryBytes?: number
  /** Default TTL in seconds for an enabled page that omits ttl; no default is assumed. */
  readonly defaultTtl?: number
}

/** Page cache settings retained until the owning runtime is prepared. */
export interface PageCacheDeclaration extends BaseDeclaration<'page_cache', PageCacheOptions> {}

/** Instance-local invalidation; completion does not imply rerendering or CDN invalidation. */
export interface PageCacheService {
  /** Invalidates cached pages matching the canonical pathname. */
  revalidatePath(path: string): Promise<void> | void
  /** Invalidates cached pages associated with the specified cache tag. */
  revalidateTag(tag: string): Promise<void> | void
}

const DEFAULT_MAX_ENTRIES = 500
const DEFAULT_MAX_BYTES = 30 * 1024 * 1024
const DEFAULT_MAX_ENTRY_BYTES = 4 * 1024 * 1024

/**
 * Declares the application's public page cache configuration.
 *
 * @param config - Capacity, body limits, and default TTL settings.
 * @returns A declaration evaluated when assembling the page cache service.
 */
export function definePageCache(config?: PageCacheOptions): PageCacheDeclaration
/**
 * Declares page cache settings resolved from the environment.
 *
 * @param factory - Configuration factory evaluated during assembly.
 * @returns A declaration preserving the factory's environment requirements.
 */
export function definePageCache<E>(
  factory: (env: E) => PageCacheOptions,
): PageCacheDeclaration & RequiresEnv<E>
export function definePageCache<E>(
  input?: PageCacheOptions | ((env: E) => PageCacheOptions),
): PageCacheDeclaration {
  return {
    kind: 'page_cache',
    value: input === undefined ? {} : input,
    isFactory: typeof input === 'function',
  }
}

/**
 * Resolves page cache options against the environment.
 *
 * @param declaration - Declared page cache configuration or factory.
 * @param env - Loaded environment.
 * @returns Validated page cache options with default values applied.
 * @throws {Error} If capacities are non-positive or non-finite, or TTL is negative or non-finite.
 */
export function resolvePageCacheOptions(
  declaration: PageCacheDeclaration,
  env: unknown,
): Required<Omit<PageCacheOptions, 'defaultTtl'>> & { defaultTtl?: number } {
  const raw = evaluateDeclaration<PageCacheOptions>(declaration.value, env, 'pageCache')
  const maxEntries = raw.maxEntries ?? DEFAULT_MAX_ENTRIES
  const maxBytes = raw.maxBytes ?? DEFAULT_MAX_BYTES
  const maxEntryBytes = raw.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES

  if (!Number.isFinite(maxEntries) || maxEntries <= 0) {
    throw new Error('pageCache maxEntries must be a positive number.')
  }
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    throw new Error('pageCache maxBytes must be a positive number.')
  }
  if (!Number.isFinite(maxEntryBytes) || maxEntryBytes <= 0) {
    throw new Error('pageCache maxEntryBytes must be a positive number.')
  }
  if (raw.defaultTtl !== undefined && (!Number.isFinite(raw.defaultTtl) || raw.defaultTtl < 0)) {
    throw new Error('pageCache defaultTtl must be a non-negative number.')
  }

  return {
    maxEntries,
    maxBytes,
    maxEntryBytes,
    defaultTtl: raw.defaultTtl,
  }
}

/**
 * Revalidates a cached path within the active application context.
 *
 * @param path - URL pathname to invalidate.
 * @returns The selected cache's invalidation result; a bound app without caching is a no-op.
 * @throws {Error} If called outside an active application execution scope.
 */
export function revalidatePath(path: string): Promise<void> | void {
  const scope = getCurrentScope()
  if (!scope?.app) {
    throw new Error('revalidatePath must be called within an active application context.')
  }
  return (scope.services?.cache as PageCacheService | undefined)?.revalidatePath(path)
}

/**
 * Revalidates a cache tag within the active application context.
 *
 * @param tag - Tag identifier to invalidate.
 * @returns The selected cache's invalidation result; a bound app without caching is a no-op.
 * @throws {Error} If called outside an active application execution scope.
 */
export function revalidateTag(tag: string): Promise<void> | void {
  const scope = getCurrentScope()
  if (!scope?.app) {
    throw new Error('revalidateTag must be called within an active application context.')
  }
  return (scope.services?.cache as PageCacheService | undefined)?.revalidateTag(tag)
}
