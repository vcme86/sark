/**
 * Server-side React 19 streaming rendering engine and loader pipeline.
 *
 * @module
 */

import { type ComponentType, createElement, type ReactNode } from 'react'
import { renderToReadableStream } from 'react-dom/server'

import { getLogger } from '../../app/logging'
import type { HttpClient } from '../../client/client'
import type { BootstrapData } from '../bootstrap'
import { DefaultError, ScopedErrorBoundary } from '../components/error'
import { DefaultRoot } from '../components/root'
import { type PageContextValue, PageProvider } from '../context'
import { toPageError } from '../errors'
import { mergeMetaDescriptors } from '../meta'
import { serializeJsonForScript } from '../serialize'
import { RedirectSignal } from '../signals'
import type { IdentitySnapshot, ServerPageScope } from '../types'

/** Server rendering execution request options. */
export interface ServerRenderOptions {
  /** Matched URL. */
  readonly url: URL
  /** Parsed route parameters. */
  readonly params: Record<string, string | string[]>
  /** Ordered scopes from root layout to leaf page component. */
  readonly scopes: readonly ServerPageScope[]
  /** Root document component, or undefined to use DefaultRoot. */
  readonly rootComponent?: ComponentType<{ children?: ReactNode }>
  /** Request abort signal. */
  readonly signal: AbortSignal
  /** Bound HTTP client for internal or remote dispatch. */
  readonly client: HttpClient<unknown>
  /** Identity snapshot resolved for this request. */
  readonly identity: IdentitySnapshot
  /** Client bootstrap module URLs supplied by the build. */
  readonly bootstrapModules: readonly string[]
  /** Extra document head stylesheets collected by asset discovery. */
  readonly stylesheets: readonly string[]
  /** Whether the host is running in production mode. */
  readonly production: boolean
  /** Browser runtime build metadata delivered via bootstrap payload. */
  readonly build: BootstrapData['build']
  /** Runtime policy delivered via bootstrap payload. */
  readonly policy: BootstrapData['policy']
  /** Reads headers after loader and shell preparation, before response commitment. */
  readonly headers: () => Headers
  /** Awaits domain header-commit hooks and seals the Cookie collector before the header snapshot. */
  readonly onCommitHeaders: () => Promise<void> | void
  /** Prepares the shell and headers but cancels body rendering for HEAD requests. */
  readonly head?: boolean
}

/**
 * Creates a complete, non-cacheable error document independent of the failed React tree.
 *
 * @param failure - Page error with a resolved HTTP status and display-safe message.
 * @returns An HTML response with the supplied status and an escaped error message.
 */
export function renderPageFailure(failure: ReturnType<typeof toPageError>): Response {
  const message = failure.message.replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[character]!,
  )
  return new Response(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Server Error</title></head><body><h1>Server Error</h1><p>${message}</p></body></html>`,
    {
      status: failure.status,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    },
  )
}

/**
 * Prepares loaders, metadata and bootstrap state before committing the React shell.
 * After commitment, React owns stream recovery and failures cannot change response headers.
 *
 * Preparation order:
 * 1. Run matched loaders concurrently, then resolve redirects and scope errors.
 * 2. Evaluate metadata and serialize the bootstrap data before starting React rendering.
 * 3. Wait for the shell, await header-commit hooks, seal the Cookie collector, and read final headers.
 * 4. Return the document stream, or cancel it and return headers only for HEAD.
 *
 * @param options - Matched scopes, request-bound client and build-owned browser resources.
 * @returns A streaming document, an explicit redirect, or an independent error document.
 * @throws If the request is cancelled; other preparation failures become page responses.
 */
export async function renderPageToResponse(options: ServerRenderOptions): Promise<Response> {
  const { url, params, scopes, signal, client, identity } = options
  let reportedStreamError: { readonly error: unknown } | undefined
  try {
    const snapshots: Record<
      string,
      | { status: 'success'; data?: unknown }
      | { status: 'error'; error: ReturnType<typeof toPageError> }
    > = {}
    const outcomes = await Promise.all(
      scopes.map(async (scope) => {
        try {
          const data = await scope.loader?.({ client, params, url, signal, identity })
          snapshots[scope.id] = { status: 'success', data }
        } catch (error) {
          if (error instanceof RedirectSignal) return error
          const failure = toPageError(error, options.production)
          if (failure.status >= 500)
            getLogger().error('Page loader failed', { scope: scope.id, error })
          snapshots[scope.id] = { status: 'error', error: failure }
        }
      }),
    )
    signal.throwIfAborted()
    const redirect = outcomes.find((outcome) => outcome instanceof RedirectSignal)
    if (redirect)
      return new Response(null, { status: redirect.status, headers: { Location: redirect.url } })

    // Metadata errors belong to their own scope; valid outer results remain usable.
    const descriptors = scopes.map((scope) => {
      const snapshot = snapshots[scope.id]
      if (!scope.meta || snapshot.status !== 'success') return undefined
      try {
        return scope.meta({ data: snapshot.data, params, url })
      } catch (error) {
        if (error instanceof RedirectSignal) throw error
        const failure = toPageError(error, options.production)
        snapshots[scope.id] = { status: 'error', error: failure }
        if (failure.status >= 500)
          getLogger().error('Page metadata failed', { scope: scope.id, error })
        return undefined
      }
    })
    const meta = mergeMetaDescriptors([
      { links: options.stylesheets.map((href) => ({ rel: 'stylesheet', href })) },
      ...descriptors,
    ])
    const bootstrapJson = serializeJsonForScript({
      build: options.build,
      policy: options.policy,
      request: { url: url.href, params, identity, scopes: snapshots },
    } satisfies BootstrapData)
    const outletChain = scopes.map((scope) => {
      const snapshot = snapshots[scope.id]
      return createElement(
        ScopedErrorBoundary,
        {
          key: scope.id,
          scopeId: scope.id,
          errorComponent: scope.errorComponent ?? DefaultError,
          initialError: snapshot.status === 'error' ? snapshot.error : undefined,
        },
        createElement(scope.component, {
          data: snapshot.status === 'success' ? snapshot.data : undefined,
          params,
          url,
        }),
      )
    })
    const context: PageContextValue = {
      client,
      url,
      params,
      identity,
      scopes: snapshots,
      navigation: { state: 'idle' },
      meta,
      outletChain,
      bootstrapJson,
      navigate: async () => ({ committed: false }),
      reload: async () => {},
      retryScope: async () => {},
      setIdentity: () => {},
      registerBlocker: () => {},
      unregisterBlocker: () => {},
    }
    // The outermost failed boundary determines the document actually presented.
    const failed = scopes
      .map((scope) => snapshots[scope.id])
      .find((snapshot) => snapshot.status === 'error')
    let status = failed?.status === 'error' ? failed.error.status : 200
    let committed = false
    let cancelled = false
    let shellRedirect: RedirectSignal | undefined
    const stream = await renderToReadableStream(
      createElement(
        PageProvider,
        { value: context },
        createElement(options.rootComponent ?? DefaultRoot),
      ),
      {
        bootstrapModules: [...options.bootstrapModules],
        signal,
        onError(error) {
          if (signal.aborted || cancelled) return
          if (!committed && error instanceof RedirectSignal) {
            shellRedirect = error
            return
          }
          const failure = toPageError(error, options.production)
          if (failure.status >= 500)
            getLogger().error('Page render stream failed', { error, committed })
          reportedStreamError = { error }
          if (!committed) status = failure.status
        },
      },
    )
    // The renderer owns the stream until a body-bearing Response is constructed successfully.
    let transferred = false
    try {
      if (shellRedirect) {
        return new Response(null, {
          status: shellRedirect.status,
          headers: { Location: shellRedirect.url },
        })
      }
      await options.onCommitHeaders()
      committed = true
      const headers = options.headers()
      headers.set('Content-Type', 'text/html; charset=utf-8')
      if (status >= 400) headers.set('Cache-Control', 'no-store')
      if (options.head) return new Response(null, { status, headers })
      const response = new Response(stream, { status, headers })
      transferred = true
      return response
    } finally {
      if (!transferred) {
        cancelled = true
        try {
          await stream.cancel()
        } catch (error) {
          getLogger().warn('Page render stream cancellation failed', { error })
        }
      }
    }
  } catch (error) {
    if (signal.aborted) throw error
    if (error instanceof RedirectSignal)
      return new Response(null, { status: error.status, headers: { Location: error.url } })
    const failure = toPageError(error, options.production)
    if (failure.status >= 500 && (!reportedStreamError || error !== reportedStreamError.error))
      getLogger().error('Page preparation failed', { error })
    return renderPageFailure(failure)
  }
}
