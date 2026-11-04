/** Bounded instance cache and native LRU fill coordination. */
import { LRUCache } from 'lru-cache'

import type { PageCacheService, resolvePageCacheOptions } from '../cache'

/** A complete, reusable, uncompressed page representation. */
export interface CachedPage {
  readonly body: Uint8Array
  readonly status: number
  readonly headers: readonly [string, string][]
  /** Freshness lifetime in seconds. */
  readonly ttl: number
  /** Additional lifetime in seconds during which stale delivery may trigger a refresh. */
  readonly staleWhileRevalidate: number
  readonly etag: string
  /** Completion time in epoch milliseconds; hits do not reset it. */
  readonly cachedAt: number
  readonly pathname: string
  readonly tags: readonly string[]
}

/** Cancellation metadata retained only while actual fill work is in progress. */
interface CacheToken {
  readonly key: string
  readonly pathname: string
  readonly tags: readonly string[]
  readonly controller: AbortController
}

export type PageCandidate = Omit<CachedPage, 'pathname' | 'tags' | 'etag' | 'cachedAt'>

/** The initiating execution retains its resources until the complete fill settles. */
export interface CacheWork {
  readonly signal: AbortSignal
  readonly waitUntil: (work: Promise<unknown>) => void
}

interface Fill extends CacheToken {
  signal?: AbortSignal
  /** Actual render work, which can outlive an aborted native fetch Promise. */
  task?: Promise<CachedPage | undefined>
  readonly work: CacheWork
  readonly render: (
    signal: AbortSignal,
    respond: (response: Response) => void,
  ) => Promise<PageCandidate | undefined>
  readonly response: ReturnType<typeof Promise.withResolvers<Response>>
  started: boolean
}

/** Shared fill deadlines also bound abandoned background work on Workers. */
const FILL_TIMEOUT = 30_000

/** Owns stored bytes and invalidation; LRU owns coalescing, capacity and TTL. */
export class PageCacheStorage implements PageCacheService {
  private readonly lru: LRUCache<string, CachedPage, Fill>
  // Shared work is indexed by cache key; request-owned captures use their own identity.
  private readonly pending = new Map<string | Fill, Fill>()
  readonly options: ReturnType<typeof resolvePageCacheOptions>

  constructor(options: ReturnType<typeof resolvePageCacheOptions>) {
    this.options = options
    this.lru = new LRUCache({
      max: options.maxEntries,
      maxSize: options.maxBytes,
      sizeCalculation: (entry) => entry.body.byteLength,
      fetchMethod: (_key, _previous, { signal, context, options: fetchOptions }) =>
        this.run(context, signal, fetchOptions),
    })
  }

  /** Reads a stored representation; callers enforce its HTTP freshness and SWR deadlines. */
  get(key: string): CachedPage | undefined {
    return this.lru.get(key, { allowStale: true })
  }

  /**
   * Starts or joins the upstream fill. Capacity exhaustion leaves rendering to the caller.
   *
   * @param key - Full URL and declared content dimensions.
   * @param pathname - Canonical page pathname used by invalidation.
   * @param tags - Tags resolved before execution starts.
   * @param work - Resource lifetime and cancellation owner.
   * @param render - Returns a complete candidate while exposing the leader's streaming response.
   * @returns A shared result and, only for the initiating caller, its streaming response.
   */
  fill(
    key: string,
    pathname: string,
    tags: readonly string[],
    work: CacheWork,
    render: Fill['render'],
  ) {
    const existing = this.pending.get(key)
    if (existing?.signal?.aborted || (!existing && this.pending.size >= this.options.maxEntries))
      return undefined
    if (existing) {
      return {
        entry: this.lru.fetch(key, { context: existing }).catch(() => undefined),
        response: undefined,
        signal: undefined,
      }
    }
    const context = this.createFill(key, pathname, tags, work, render)
    // The complete render is observed by its owner; an upstream cancellation is a cache miss.
    const entry = this.lru.fetch(key, { context, forceRefresh: true }).catch(() => undefined)
    // The supported LRU invokes fetchMethod synchronously, attaching the actual task before return.
    if (context.started) {
      // Hold ownership through both real rendering and the native placeholder's final commit.
      const completed = Promise.allSettled([entry, context.task!]).then(([, rendered]) => {
        this.pending.delete(key)
        if (rendered.status === 'rejected') throw rendered.reason
      })
      work.waitUntil(completed)
    }
    return {
      entry,
      response: context.started ? context.response.promise : undefined,
      signal: context.signal,
    }
  }

  /**
   * Captures an independent request without replacing an active shared fill.
   *
   * @param key - Full URL and declared content dimensions.
   * @param pathname - Page pathname used by invalidation.
   * @param tags - Tags resolved before rendering starts.
   * @param work - Resource lifetime and instance cancellation owner.
   * @param signal - Cancellation of this independent request.
   * @param render - Produces a streaming response and an eligible complete representation.
   * @returns Its streaming response, or undefined when capture capacity is exhausted.
   */
  capture(
    key: string,
    pathname: string,
    tags: readonly string[],
    work: CacheWork,
    signal: AbortSignal,
    render: Fill['render'],
  ): Promise<Response> | undefined {
    if (this.pending.size >= this.options.maxEntries) return undefined
    const fill = this.createFill(key, pathname, tags, work, render)
    this.run(fill, signal)
    return fill.response.promise
  }

  revalidatePath(path: string): void {
    const url = new URL(path, 'http://cache.invalid')
    this.invalidate((token) => token.pathname === (url.pathname.replace(/\/$/, '') || '/'))
  }

  revalidateTag(tag: string): void {
    this.invalidate((token) => token.tags.includes(tag))
  }

  /** Invalidates entries and pending writers without treating cancellation as work completion. */
  clear(): void {
    this.invalidate(() => true)
    this.lru.clear()
  }

  private createFill(
    key: string,
    pathname: string,
    tags: readonly string[],
    work: CacheWork,
    render: Fill['render'],
  ): Fill {
    return {
      key,
      pathname: pathname.replace(/\/$/, '') || '/',
      tags,
      work,
      render,
      controller: new AbortController(),
      response: Promise.withResolvers<Response>(),
      started: false,
    }
  }

  /**
   * Runs capture while retaining the real work until it settles.
   * Shared submission ownership is released by fill after the native LRU commit also settles.
   *
   * @param fill - Render inputs, response handoff, and resource owner.
   * @param upstream - Native fetch or independent request cancellation signal.
   * @param fetchOptions - Native submission settings; omitted for independent request capture.
   * @returns A complete representation, or undefined when capture cannot be committed.
   * @throws If rendering fails after response handoff and the work was not cancelled.
   */
  private run(
    fill: Fill,
    upstream: AbortSignal,
    fetchOptions?: { ttl?: number },
  ): Promise<CachedPage | undefined> {
    fill.started = true
    const identity = fetchOptions ? fill.key : fill
    this.pending.set(identity, fill)
    const signal = AbortSignal.any([
      upstream,
      fill.controller.signal,
      fill.work.signal,
      AbortSignal.timeout(FILL_TIMEOUT),
    ])
    fill.signal = signal
    let responded = false
    const task = (async () => {
      try {
        const candidate = await fill.render(signal, (response) => {
          responded = true
          fill.response.resolve(response)
        })
        if (signal.aborted) return undefined
        if (!candidate) {
          // An undefined fetch restores stale data upstream; an ineligible render must retire it.
          if (fetchOptions) this.lru.delete(fill.key)
          return undefined
        }
        // Native LRU replacement aborts a shared fill; retain that owner and its waiting clients.
        if (!fetchOptions && this.pending.has(fill.key)) return undefined
        const entry = this.complete(fill, candidate)
        const ttl = (entry.ttl + entry.staleWhileRevalidate) * 1000
        if (fetchOptions) fetchOptions.ttl = ttl
        else this.lru.set(fill.key, entry, { ttl })
        return entry
      } catch (error) {
        fill.response.reject(error)
        // Before delivery, the HTTP owner reports failure; later failures belong to background work.
        if (responded && !signal.aborted) throw error
        return undefined
      } finally {
        if (!fetchOptions) this.pending.delete(identity)
      }
    })()
    fill.task = task
    if (!fetchOptions) fill.work.waitUntil(task)
    return task
  }

  /** Builds stored data without retaining the fill's request or work owner. */
  private complete(token: CacheToken, candidate: PageCandidate): CachedPage {
    return {
      ...candidate,
      pathname: token.pathname,
      tags: token.tags,
      cachedAt: Date.now(),
      etag: weakEtag(candidate.body),
    }
  }

  private invalidate(matches: (item: Pick<CacheToken, 'pathname' | 'tags'>) => boolean): void {
    // Invalidations are infrequent and bounded by cache capacity; no tombstone/index maps accumulate.
    for (const token of this.pending.values()) {
      if (matches(token)) {
        token.controller.abort()
        this.lru.delete(token.key)
      }
    }
    for (const [key, entry] of this.lru) {
      if (matches(entry)) this.lru.delete(key)
    }
  }
}

function weakEtag(bytes: Uint8Array): string {
  let hash = 2166136261
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619)
  return `W/"${bytes.length.toString(16)}-${(hash >>> 0).toString(16)}"`
}
