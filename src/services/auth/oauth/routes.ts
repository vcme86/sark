/** Static OAuth endpoint descriptions reading the current event's resolved binding. */
import { getCurrentScope } from '../../../core/context'
import { type ParsedRoutePath, routeShape } from '../../../web/http/path'
import type { RouteEntry } from '../../../web/http/server/pipeline'
import type { DiscoveryCache } from './client'
import { handleCallback, handleSignIn } from './flow'
import type { ResolvedOAuthProvider } from './types'

/** Private OAuth binding state, shared by same-application internal calls. */
export interface OAuthRequestState {
  readonly providers: ReadonlyMap<string, ResolvedOAuthProvider>
  readonly secret: string
  readonly production: boolean
  readonly discovery: DiscoveryCache
}

/** Creates static routes without capturing environment-specific credentials or callbacks. */
export function createOAuthRoutes(providers: readonly ResolvedOAuthProvider[]): RouteEntry[] {
  return providers.flatMap((provider) => [
    createRoute('GET', provider.signInPath, provider.id, false),
    createRoute(provider.callbackMethod, provider.callbackPath, provider.id, true),
  ])
}

function createRoute(method: string, path: string, id: string, callback: boolean): RouteEntry {
  const routePath: ParsedRoutePath = {
    urlPath: path,
    clientPath: path,
    shapeKey: routeShape(path),
    method,
    segments: path
      .split('/')
      .filter(Boolean)
      .map((raw) => ({ kind: 'static', raw })),
    isSse: false,
    isWs: false,
  }
  return {
    routePath,
    kind: 'api',
    declaration: {
      isRoute: true,
      options: { csrf: false, middleware: [] },
      validators: {},
      async handler(ctx) {
        const state = getCurrentScope()!.serviceBindings!.oauth.state as OAuthRequestState
        const provider = state.providers.get(id)!
        return callback
          ? handleCallback(provider, ctx, state.secret, state.discovery)
          : handleSignIn(provider, ctx, state.secret, state.production, state.discovery)
      },
    },
  }
}
