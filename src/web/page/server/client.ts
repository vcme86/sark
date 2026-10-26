import type { Context } from 'hono'

import type { ExecutionScope, RequestScope } from '../../../core/context'
import { createClient, type DefaultApi, type HttpClient } from '../../http/client/client'
import { captureResponsePolicy } from '../../http/server/cache-control'
import type { ResolvedPageConfig } from '../config'

/**
 * Reads page-owned settings from the current instance or event scope.
 *
 * @param scope - Execution scope carrying page settings from the generated resolver.
 * @returns Settings already resolved by the owning host.
 * @throws {Error} If page assembly did not provide its configuration.
 */
export function getResolvedPageConfig<Api = DefaultApi>(
  scope: ExecutionScope,
): ResolvedPageConfig<Api> {
  const config = scope.pageConfig
  if (config === undefined) {
    throw new Error('Page configuration is unavailable outside an assembled page application.')
  }
  // The generated resolver owns this value; the core carries it without loading page code.
  return config as ResolvedPageConfig<Api>
}

/**
 * Binds page API calls to the local application or the configured remote target.
 * Remote credentials are inherited only within that target's API base path.
 * Local Cookie collection belongs to fetchInternal; remote responses use scope.appendCookies.
 * Remote redirects are returned without following them or forwarding credentials onward.
 *
 * @param context - Current Hono request and response context.
 * @param localClient - Client dispatching to this application without a network loopback.
 * @param config - Page-owned resolved transport and identity settings.
 * @param scope - Current request metadata, cancellation, and outer Cookie collector.
 * @returns A request-bound client preserving the caller's API type.
 */
export function createPageClient<Api>(
  context: Context,
  localClient: HttpClient<Api>,
  config: ResolvedPageConfig<Api>,
  scope: RequestScope,
): HttpClient<Api> {
  if (config.api.serverUrl === undefined) return localClient

  const target = new URL(config.api.serverUrl)
  const prefix = target.pathname.replace(/\/$/, '')
  return createClient<Api>({
    baseUrl: config.api.serverUrl,
    credentials: config.api.credentials,
    async fetch(request) {
      const url = new URL(request.url)
      const trusted =
        url.origin === target.origin &&
        (url.pathname === prefix || url.pathname.startsWith(`${prefix}/`))
      if (!trusted) return fetch(request)

      const headers = new Headers(request.headers)
      for (const name of ['cookie', 'authorization', 'origin']) {
        const value = context.req.header(name)
        if (value !== undefined && !headers.has(name)) headers.set(name, value)
      }
      if (!headers.has('x-request-id')) headers.set('x-request-id', scope.requestId)

      const signal = AbortSignal.any([request.signal, scope.signal])
      const response = await fetch(new Request(request, { headers, signal, redirect: 'manual' }))
      scope.appendCookies(response.headers.getSetCookie())
      captureResponsePolicy(context, response)
      return response
    },
  })
}
