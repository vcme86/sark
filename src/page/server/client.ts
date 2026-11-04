import type { Context } from 'hono'

import type { ExecutionScope, RequestScope } from '../../app/context'
import { createClient, type DefaultApi, type HttpClient } from '../../client/client'
import type { ResolvedPageConfig } from '../config'
import { captureResponsePolicy } from './response-policy'

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
 * @param config - Page-owned resolved transport and identity settings.
 * @param scope - Current request metadata, cancellation, and outer Cookie collector.
 * @returns A request-bound client preserving the caller's API type.
 */
export function createPageClient<Api>(
  context: Context,
  config: ResolvedPageConfig<Api>,
  scope: RequestScope,
): HttpClient<Api> {
  const local = config.api.serverUrl === undefined
  const instance = scope.app
  const apiPrefix = instance?.definition.apiPrefix
  if (local && (!instance || apiPrefix === undefined)) {
    throw new Error('Local page dispatch requires an assembled application and API prefix.')
  }
  const target = new URL(local ? apiPrefix : config.api.serverUrl!, scope.externalOrigin)
  const prefix = target.pathname.replace(/\/$/, '')
  return createClient<Api>({
    baseUrl: target.href,
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

      const response = local
        ? await instance!.fetchInternal(new Request(request, { headers }))
        : await fetch(
            new Request(request, {
              headers,
              signal: AbortSignal.any([request.signal, scope.signal]),
              redirect: 'manual',
            }),
          )
      if (!local) scope.appendCookies(response.headers.getSetCookie())
      captureResponsePolicy(context, response)
      return response
    },
  })
}
