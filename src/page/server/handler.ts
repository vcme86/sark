import type { Context } from 'hono'

import type { PageRequestHandler } from '../../app/http/assembly'
import { getLogger } from '../../app/logging'
import type { RequestVisitorState } from '../../features/visitors/request'
import { toPageError } from '../errors'
import { matchPattern } from '../match'
import { notFound } from '../signals'
import type { IdentitySnapshot, ServerPageRoute } from '../types'
import { renderCachedPage } from './cached-render'
import { createPageClient, getResolvedPageConfig } from './client'
import type { ClientAssetManifest } from './manifest'
import { pageHeaders, type PageHttpCache, resolvePageCache } from './policy'
import { renderPageFailure, renderPageToResponse } from './render'

/** Resource selection supplied by the development or production build entry. */
type PageAssetProvider = () => ClientAssetManifest | Promise<ClientAssetManifest>

/**
 * Binds a discovered page to request configuration, identity, assets, and the SSR renderer.
 * Optionally integrates with instance-level LRU page cache when enabled.
 *
 * @param route - Matched page and its ordered layout/loader/error scopes.
 * @param assets - Resolves this route's current development or production browser resources.
 * @returns A page terminal creating its API client from the current request scope.
 */
export function createPageHandler(
  route: ServerPageRoute,
  assets: PageAssetProvider,
): PageRequestHandler {
  const cachePolicy = resolvePageCache(route.scopes)
  return (ctx, scope, production) => {
    const params = matchPattern(
      route.pattern,
      ctx.req.path,
      route.paramNames,
      scope.config.caseSensitive,
    )
    if (params === null) throw new Error(`Page handler did not match its route: ${route.pattern}`)
    return renderCachedPage(ctx, scope, cachePolicy, params, (context, execution, policy) =>
      executeRender(context, execution, production, route, assets, params, policy),
    )
  }
}

/** Prepares and renders an uncached SSR response, formatting preparation failures as page errors. */
async function executeRender(
  ctx: Context,
  scope: Parameters<PageRequestHandler>[1],
  production: boolean,
  route: ServerPageRoute,
  assets: PageAssetProvider,
  params: Record<string, string | string[]>,
  cachePolicy: PageHttpCache | undefined,
): Promise<Response> {
  try {
    const config = getResolvedPageConfig(scope)
    const client = createPageClient(ctx, config, scope)
    const identity: IdentitySnapshot = config.identity
      ? await config.identity({ client, signal: scope.signal })
      : defaultIdentity(ctx, config.api.serverUrl === undefined)
    const resources = await assets()
    const url = new URL(scope.externalOrigin)
    const requestUrl = new URL(ctx.req.url)
    url.pathname = requestUrl.pathname
    url.search = requestUrl.search
    const visitorPath = (scope.serviceBindings?.visitors?.state as RequestVisitorState | undefined)
      ?.endpointPath
    return renderPageToResponse({
      url,
      params,
      scopes: route.scopes,
      rootComponent: route.rootComponent,
      signal: scope.signal,
      client,
      identity,
      production,
      head: ctx.req.method === 'HEAD',
      bootstrapModules: resources.bootstrapModules,
      stylesheets: resources.stylesheets,
      build: {
        api: { browserUrl: config.api.browserUrl, credentials: config.api.credentials },
        styles: resources.routeStyles,
        ...(visitorPath ? { visitor: { path: visitorPath } } : {}),
      },
      policy: {
        caseSensitive: scope.config.caseSensitive,
        trailingSlash: scope.config.trailingSlash,
      },
      headers: () => pageHeaders(ctx, cachePolicy, production, identity.user !== null),
      onCommitHeaders: scope.commitResponseHeaders,
    })
  } catch (error) {
    if (scope.signal.aborted) throw error
    const failure = toPageError(error, production)
    if (failure.status >= 500) getLogger().error('Page preparation failed', { error })
    return renderPageFailure(failure)
  }
}

/** Copies only display-safe claims from the request authentication service. */
function defaultIdentity(
  context: Parameters<PageRequestHandler>[0],
  local: boolean,
): IdentitySnapshot {
  const identity: IdentitySnapshot['user'] | undefined = local
    ? context.get('auth')?.identity
    : undefined
  return { user: identity ? { sub: identity.sub, roles: identity.roles } : null }
}

/**
 * Builds an HTML 404 terminal without running application layout loaders.
 *
 * @param rootComponent - Root document component, or undefined for the default root.
 * @param errorComponent - Root error presentation, or undefined for the default error component.
 * @param assets - Resolves root resources and the browser entry used to hydrate the 404 document.
 * @returns A page terminal with a single not-found scope.
 */
export function createPage404Handler(
  rootComponent: ServerPageRoute['rootComponent'],
  errorComponent: ServerPageRoute['scopes'][number]['errorComponent'],
  assets: PageAssetProvider,
): PageRequestHandler {
  return createPageHandler(
    {
      pattern: '/*',
      shapeKey: '/*',
      paramNames: [],
      rootComponent,
      httpScopes: [],
      scopes: [
        {
          id: 'not-found',
          component: () => null,
          errorComponent,
          loader: () => notFound('Page Not Found'),
        },
      ],
    },
    assets,
  )
}
