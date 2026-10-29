import { getLogger } from '../../core/logging'
import type { PageRequestHandler } from '../../http/server/types'
import type { RequestVisitorState } from '../../services/visitors/request'
import { toPageError } from '../errors'
import { matchPattern } from '../match'
import { notFound } from '../signals'
import type { IdentitySnapshot, ServerPageRoute } from '../types'
import { createPageClient, getResolvedPageConfig } from './client'
import type { ClientAssetManifest } from './manifest'
import { pageHeaders, resolvePageCache } from './policy'
import { renderPageFailure, renderPageToResponse } from './render'

/** Resource selection supplied by the development or production build entry. */
type PageAssetProvider = () => ClientAssetManifest | Promise<ClientAssetManifest>

/**
 * Binds a discovered page to request configuration, identity, assets, and the SSR renderer.
 * Hono owns middleware/method dispatch; page preparation failures use the page error response.
 *
 * @param route - Matched page and its ordered layout/loader/error scopes.
 * @param assets - Resolves this route's current development or production browser resources.
 * @returns A page terminal accepting the current request scope and internal API client.
 */
export function createPageHandler(
  route: ServerPageRoute,
  assets: PageAssetProvider,
): PageRequestHandler {
  const cache = resolvePageCache(route.scopes)
  return async (ctx, localClient, scope, production) => {
    try {
      const params = matchPattern(
        route.pattern,
        ctx.req.path,
        route.paramNames,
        scope.config.caseSensitive,
      )
      if (params === null) throw new Error(`Page handler did not match its route: ${route.pattern}`)
      const config = getResolvedPageConfig(scope)
      const client = createPageClient(ctx, localClient, config, scope)
      const identity: IdentitySnapshot = config.identity
        ? await config.identity({ client, signal: scope.signal })
        : defaultIdentity(ctx, config.api.serverUrl === undefined)
      const resources = await assets()
      const url = new URL(scope.externalOrigin)
      const requestUrl = new URL(ctx.req.url)
      url.pathname = requestUrl.pathname
      url.search = requestUrl.search
      const visitorPath = (
        scope.serviceBindings?.visitors?.state as RequestVisitorState | undefined
      )?.endpointPath
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
        headers: () => pageHeaders(ctx, cache, production, identity.user !== null),
        onCommitHeaders: scope.commitResponseHeaders,
      })
    } catch (error) {
      if (scope.signal.aborted) throw error
      const failure = toPageError(error, production)
      if (failure.status >= 500) getLogger().error('Page preparation failed', { error })
      return renderPageFailure(failure)
    }
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
