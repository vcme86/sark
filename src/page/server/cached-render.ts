/** Public page cache policy, owned rendering and final-response capture. */
import { Context } from 'hono'

import { type RequestScope, runInScope } from '../../app/context'
import { bindRequestServices, createRequestScope } from '../../app/http/request-context'
import { matchesETag } from '../../http/etag'
import type { PageCacheRuntime } from './assembly'
import type { CachedPage, PageCacheStorage, PageCandidate } from './cache'
import { type PageHttpCache, parseCacheDirectives, resolveCacheTags } from './policy'

type RenderPage = (
  context: Context,
  scope: RequestScope,
  policy?: PageHttpCache,
) => Promise<Response>

/**
 * Applies optional cache storage after the original request has passed business admission.
 *
 * @param context - Admitted request and its application response middleware.
 * @param scope - Current HTTP scope; only the fill's resources outlive its delivery.
 * @param policy - Resolved layout/page policy, independent of storage configuration.
 * @param params - Matched route parameters for early tag resolution.
 * @param render - Existing SSR pipeline, also used by uncached requests.
 * @returns A streamed render, a reusable representation, or an independent waiter fallback.
 */
export async function renderCachedPage(
  context: Context,
  scope: RequestScope,
  policy: PageHttpCache | undefined,
  params: Record<string, string | string[]>,
  render: RenderPage,
): Promise<Response> {
  const runtime = scope.services?.cache as PageCacheRuntime | undefined
  const ttl = policy?.ttl ?? runtime?.storage.options.defaultTtl
  const request = context.req.raw
  if (
    !runtime ||
    !scope.config.production ||
    !policy ||
    ttl === undefined ||
    ttl <= 0 ||
    request.headers.has('cookie') ||
    request.headers.has('authorization') ||
    /\bno-store\b/i.test(request.headers.get('cache-control') ?? '')
  ) {
    return render(context, scope, policy)
  }

  const effective = { ...policy, ttl }
  const execute: RenderPage = (ctx, execution) => render(ctx, execution, effective)
  if (
    !eligible(
      context.res.status,
      context.res.headers,
      effective.vary,
      context.res.headers.get('vary'),
    )
  ) {
    return execute(context, scope)
  }
  const storage = runtime.storage
  const url = new URL(request.url)
  const key = cacheKey(scope.externalOrigin, url, effective.vary, request.headers)
  const tags = resolveCacheTags(effective, params)
  const noCache = /\bno-cache\b/i.test(request.headers.get('cache-control') ?? '')

  const renderShared = (signal: AbortSignal) => renderOwned(context, scope, signal, execute)
  const capture =
    (produce: (signal: AbortSignal) => Promise<Response>, staleResponse?: Response) =>
    async (
      signal: AbortSignal,
      respond: (response: Response) => void,
    ): Promise<PageCandidate | undefined> => {
      const finalized = Promise.withResolvers<Response>()
      scope.onResponse = finalized.resolve
      const response = await produce(signal)
      if (
        !response.body ||
        !eligible(response.status, response.headers, effective.vary, response.headers.get('vary'))
      ) {
        respond(staleResponse ?? response)
        if (staleResponse) await response.body?.cancel()
        return undefined
      }
      const [clientBody, collector] = staleResponse ? [null, response.body] : response.body.tee()
      const delivery = staleResponse ?? new Response(clientBody, response)
      const deliveredHeaders = new Headers(delivery.headers)
      const deliveredBody = delivery.body
      respond(delivery)
      const body = await collectBody(collector, storage.options.maxEntryBytes, signal)
      if (!body) return undefined
      const final = await finalized.promise
      if (
        signal.aborted ||
        final.status !== delivery.status ||
        (request.method !== 'HEAD' && final.body !== deliveredBody)
      )
        return undefined
      const headers = new Headers(response.headers)
      // Apply middleware changes to the new representation, rather than copying old SWR metadata.
      for (const name of new Set([...deliveredHeaders.keys(), ...final.headers.keys()])) {
        if (deliveredHeaders.get(name) === final.headers.get(name)) continue
        if (final.headers.has(name)) headers.set(name, final.headers.get(name)!)
        else headers.delete(name)
      }
      const contentVary = scope.contentVary === undefined ? headers.get('vary') : scope.contentVary
      if (!eligible(final.status, headers, effective.vary, contentVary)) return undefined
      const contentTokens = new Set(
        [...(response.headers.get('vary') ?? '').split(','), ...(contentVary ?? '').split(',')]
          .map((value) => value.trim())
          .filter(Boolean),
      )
      if (contentTokens.size) headers.set('vary', [...contentTokens].join(', '))
      else headers.delete('vary')
      const timing = parseCacheDirectives(
        headers.get('cache-control'),
        effective.ttl,
        effective.staleWhileRevalidate,
      )
      if (timing.ttl + timing.staleWhileRevalidate <= 0) return undefined
      return { body, status: response.status, headers: reusableHeaders(headers), ...timing }
    }

  if (noCache) {
    return (
      storage.capture(
        key,
        url.pathname,
        tags,
        runtime.work,
        scope.signal,
        capture(() => execute(context, scope)),
      ) ?? execute(context, scope)
    )
  }

  const cached = storage.get(key)
  if (cached && Date.now() < cached.cachedAt + (cached.ttl + cached.staleWhileRevalidate) * 1000) {
    const response = await deliver(context, scope, storage, key, cached)
    if (response) {
      if (Date.now() >= cached.cachedAt + cached.ttl * 1000) {
        const fill = storage.fill(
          key,
          url.pathname,
          tags,
          runtime.work,
          capture(renderShared, response),
        )
        // Observe background failure before a streaming response has been handed off.
        if (fill?.response) {
          runtime.work.waitUntil(fill.response)
        }
      }
      return response
    }
  }
  const fill = storage.fill(key, url.pathname, tags, runtime.work, capture(renderShared))
  if (!fill) {
    scope.onResponse = undefined
    return execute(context, scope)
  }
  if (fill.response) {
    return waitFor(fill.response, fill.signal!).catch((error) => {
      scope.onResponse = undefined
      if (!fill.signal!.aborted || scope.signal.aborted) throw error
      return execute(context, scope)
    })
  }
  // Joining an existing fill does not install a response observer on this request.
  scope.onResponse = undefined
  const filled = await waitFor(fill.entry, scope.signal)
  const response = filled && (await deliver(context, scope, storage, key, filled))
  return response || execute(context, scope)
}

/**
 * Renders with admitted metadata and fresh mutable HTTP state.
 *
 * 1. Create a real Hono context without inheriting mutable request bindings or Cookie state.
 * 2. Bind the selected services inside the new execution scope.
 * 3. Render and commit its headers; the initiating work owner retains shared event resources.
 */
async function renderOwned(
  context: Context,
  parent: RequestScope,
  signal: AbortSignal,
  render: RenderPage,
): Promise<Response> {
  const request = new Request(context.req.raw, { method: 'GET', signal })
  const ctx = new Context(request, {
    env: context.env,
    path: context.req.path,
    executionCtx: parent.executionCtx as Context['executionCtx'] | undefined,
  })
  ctx.res = new Response(null, { headers: context.res.headers })
  const scope = createRequestScope(ctx, {
    ...parent,
    signal,
    isInternal: true,
    contentVary: undefined,
    serviceBindings: undefined,
    isHeadersCommitted: undefined,
    dedupStore: new Map(),
  })
  return runInScope(scope, async () => {
    await bindRequestServices(ctx, async () => {
      ctx.res = await render(ctx, scope)
      await scope.commitResponseHeaders()
    })
    return ctx.res
  })
}

/** Rechecks entry validity after asynchronous header commitment, then applies conditional delivery. */
async function deliver(
  context: Context,
  scope: RequestScope,
  storage: PageCacheStorage,
  key: string,
  entry: CachedPage,
): Promise<Response | undefined> {
  await scope.commitResponseHeaders()
  if (
    storage.get(key) !== entry ||
    Date.now() >= entry.cachedAt + (entry.ttl + entry.staleWhileRevalidate) * 1000
  )
    return undefined
  const headers = new Headers([...entry.headers])
  for (const [name, value] of context.res.headers) headers.set(name, value)
  const vary = new Set(
    [
      ...(entry.headers.find(([name]) => name === 'vary')?.[1] ?? '').split(','),
      ...(headers.get('vary') ?? '').split(','),
    ]
      .map((value) => value.trim())
      .filter(Boolean),
  )
  if (vary.size) headers.set('Vary', [...vary].join(', '))
  headers.set('Age', String(Math.max(0, Math.floor((Date.now() - entry.cachedAt) / 1000))))
  headers.set('ETag', entry.etag)
  const notModified = matchesETag(context.req.header('if-none-match') ?? '', entry.etag, true)
  return new Response(
    notModified || context.req.method === 'HEAD' ? null : (entry.body as BodyInit),
    { status: notModified ? 304 : entry.status, headers },
  )
}

function cacheKey(
  origin: string,
  url: URL,
  vary: readonly string[] = [],
  headers: Headers,
): string {
  const dimensions = [...new Set(vary.map((name) => name.toLowerCase()))]
    .toSorted()
    .map((name) => [name, headers.get(name) ?? ''])
  return JSON.stringify([origin, url.pathname, url.search, dimensions])
}

function eligible(
  status: number,
  headers: Headers,
  declared: readonly string[] = [],
  contentVary: string | null,
): boolean {
  if (
    status < 200 ||
    status >= 300 ||
    headers.has('set-cookie') ||
    /\b(private|no-store|no-cache)\b/i.test(headers.get('cache-control') ?? '')
  )
    return false
  const allowed = new Set([...declared.map((name) => name.toLowerCase()), 'accept-encoding'])
  return (contentVary ?? '')
    .split(',')
    .every((name) => !name.trim() || allowed.has(name.trim().toLowerCase()))
}

/** Omits delivery-specific fields rebuilt by the current request middleware and host. */
function reusableHeaders(headers: Headers): [string, string][] {
  const omitted = new Set([
    'set-cookie',
    'x-request-id',
    'content-length',
    'content-encoding',
    'connection',
    'transfer-encoding',
    'keep-alive',
    'age',
    'etag',
  ])
  return [...headers].filter(([name]) => !omitted.has(name) && !name.startsWith('access-control-'))
}

/**
 * Collects a complete representation within the capture budget.
 *
 * @param stream - Capture branch or background response body.
 * @param limit - Maximum accepted body size in bytes.
 * @param signal - Work cancellation, independent of other waiting clients.
 * @returns Complete bytes, or undefined on overflow, cancellation, or an incomplete body.
 */
async function collectBody(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  signal: AbortSignal,
): Promise<Uint8Array | undefined> {
  const reader = stream.getReader()
  // Awaiting cancellation of a tee branch can block on the client's delivery branch.
  const cancel = () => {
    void reader.cancel(signal.reason).catch(() => {})
  }
  signal.addEventListener('abort', cancel, { once: true })
  if (signal.aborted) cancel()
  try {
    const chunks: Uint8Array[] = []
    let size = 0
    while (!signal.aborted) {
      const chunk = await reader.read()
      if (chunk.done) {
        const body = new Uint8Array(size)
        let offset = 0
        for (const bytes of chunks) {
          body.set(bytes, offset)
          offset += bytes.length
        }
        return signal.aborted ? undefined : body
      }
      size += chunk.value.length
      if (size > limit) {
        void reader.cancel().catch(() => {})
        return undefined
      }
      chunks.push(chunk.value)
    }
    return undefined
  } catch {
    return undefined
  } finally {
    signal.removeEventListener('abort', cancel)
    reader.releaseLock()
  }
}

/**
 * Cancels only this caller's wait, leaving the shared work under its existing owner.
 *
 * @param work - Work whose result the caller needs.
 * @param signal - This caller's cancellation signal.
 * @returns The work's result while the caller is still waiting.
 * @throws If the caller aborts or the work rejects.
 */
async function waitFor<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  const cancelled = Promise.withResolvers<never>()
  const abort = () => cancelled.reject(signal.reason)
  signal.addEventListener('abort', abort, { once: true })
  try {
    return await Promise.race([work, cancelled.promise])
  } finally {
    signal.removeEventListener('abort', abort)
  }
}
