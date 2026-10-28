/**
 * HTTP middleware composition, route admission, dispatch, and error responses.
 *
 * @module
 */

import { type Context, Hono, type MiddlewareHandler } from 'hono'
import { every } from 'hono/combine'
import { matchedRoutes } from 'hono/route'
import { TrieRouter } from 'hono/router/trie-router'
import { getPath as getRequestPath } from 'hono/utils/url'

import { getCurrentScope, type RequestScope } from '../../core/context'
import { getLogger } from '../../core/logging'
import type { AppInstance } from '../../core/types'
import { createClient } from '../client/client'
import type { ResolvedHttpConfig } from '../config'
import { HttpError } from '../error'
import { cors as sarkCors } from '../middleware/cors'
import { csrf as sarkCsrf } from '../middleware/csrf'
import {
  checkUrlNormalization,
  compareRoutes,
  createRouteCanonicalizer,
  type RouteCanonicalizer,
  routeShape,
} from '../path'
import { captureResponsePolicy } from '../response-policy'
import { bodyLimit as requestBodyLimit } from './body-limit'
import { parseAndValidateInput } from './input'
import {
  formatErrorResponse,
  formatResponse,
  preserveMiddlewareCookies,
  preserveResponseCookies,
} from './output'
import { computeEffectivePolicy } from './policy'
import { bindRequestServices, requestContext } from './request-context'
import type { PageRequestHandler, RouteEntry } from './types'

interface RequestPolicy {
  cors?: MiddlewareHandler
  admission?: MiddlewareHandler
}

interface RequestPolicies {
  selectedEntry?: RouteEntry
  route: RequestPolicy
  preflight?: RequestPolicy
}

interface IndexedRoute {
  method: string
  entry: RouteEntry
}

const METHOD_INDEX = '__SARK_PATH__'

function preflightMethod(request: Request): string | undefined {
  return request.method === 'OPTIONS' && request.headers.has('origin')
    ? request.headers.get('access-control-request-method')?.toUpperCase()
    : undefined
}

function compilePolicy(effective: ReturnType<typeof computeEffectivePolicy>): RequestPolicy {
  const csrf = effective.csrf === false ? undefined : sarkCsrf(effective.csrf)
  const bodyLimit =
    effective.bodyLimit === false ? undefined : requestBodyLimit(effective.bodyLimit)
  let admission = csrf ?? bodyLimit
  if (csrf && bodyLimit) {
    admission = async (ctx, next) => {
      await csrf(ctx, async () => {
        await bodyLimit(ctx, next)
      })
    }
  }
  return {
    cors: effective.cors === false ? undefined : sarkCors(effective.cors),
    admission,
  }
}

/**
 * Builds the HTTP pipeline with policies selected for the winning route.
 * Route policy overrides replace defaults rather than stacking with them.
 *
 * Request order:
 * 1. Establish the execution scope, request ID, source metadata, and Cookie collector.
 * 2. Apply the selected CORS policy, including target-method preflight handling.
 * 3. Check lifecycle admission and GET/HEAD URL normalization.
 * 4. Bind request services, inheriting same-application internal request state.
 * 5. Apply the selected route's CSRF and body-limit policies.
 * 6. Run application, directory-scope, and route middleware in that order.
 * 7. Parse declared inputs, execute the handler, and format its response.
 * 8. Resolve unmatched methods as 405, then optionally render the HTML 404 document.
 *
 * CORS precedes admission so rejections retain applicable CORS headers. Request
 * context awaits domain header-commit hooks before sealing the Cookie collector,
 * then applies security headers after downstream execution returns. SSR commits
 * those hooks before taking its response header snapshot.
 * Unknown-length body limits are enforced during consumption, not before all middleware.
 *
 * @param config - Resolved instance settings or a getter for the already resolved event settings.
 * @param routes - List of registered route entries.
 * @param instanceProvider - Lazy accessor returning the current application instance.
 * @param apiPrefix - Resolved API base path for the page-bound internal client.
 * @param page404Handler - Optional HTML terminal for unmatched page requests.
 * @param webPrefix - Resolved website route prefix, including its HTML 404 scope.
 * @returns Fully compiled Hono application instance.
 */
export function buildHttpApp(
  config: ResolvedHttpConfig | (() => ResolvedHttpConfig),
  routes: RouteEntry[],
  instanceProvider?: () => AppInstance | undefined,
  apiPrefix?: string,
  page404Handler?: PageRequestHandler,
  webPrefix?: string,
): Hono<any> {
  const getConfig = typeof config === 'function' ? config : () => config
  const orderedRoutes = routes.toSorted((a, b) => compareRoutes(a.routePath, b.routePath))
  const uniqueRoutes = new Map<string, RouteEntry>()
  for (const entry of orderedRoutes) {
    if (
      entry.kind !== 'page' &&
      (entry.routePath.method === 'GET' || entry.routePath.method === 'HEAD') &&
      (entry.declaration.validators.json ||
        entry.declaration.validators.form ||
        entry.declaration.validators.text)
    ) {
      throw new Error(
        `${entry.source ?? entry.routePath.urlPath}: ${entry.routePath.method} routes cannot declare a request body schema.`,
      )
    }
    const key = `${entry.routePath.method}:${routeShape(entry.routePath.urlPath)}`
    const previous = uniqueRoutes.get(key)
    if (previous) {
      throw new Error(
        `Route conflict: ${entry.routePath.method} ${entry.routePath.urlPath} between ${previous.source ?? key} and ${entry.source ?? key}`,
      )
    }
    uniqueRoutes.set(key, entry)
  }
  const handlerToEntry = new Map<object, RouteEntry>()
  const requestPolicies = new WeakMap<Context, RequestPolicies>()
  const methodRouter = new TrieRouter<IndexedRoute>()

  const policyCache = new WeakMap<
    ResolvedHttpConfig,
    {
      defaultPolicy: RequestPolicy
      applicationPolicy: RequestPolicy
      routePolicies: Map<RouteEntry, RequestPolicy>
    }
  >()

  function getPoliciesForConfig(cfg: ResolvedHttpConfig) {
    let cached = policyCache.get(cfg)
    if (!cached) {
      const applicationPolicy = compilePolicy(cfg)
      cached = {
        defaultPolicy: { cors: applicationPolicy.cors },
        applicationPolicy,
        routePolicies: new Map<RouteEntry, RequestPolicy>(),
      }
      policyCache.set(cfg, cached)
    }
    return cached
  }

  function getRoutePolicy(cfg: ResolvedHttpConfig, entry: RouteEntry): RequestPolicy {
    const { routePolicies, applicationPolicy } = getPoliciesForConfig(cfg)
    let policy = routePolicies.get(entry)
    if (!policy) {
      const effective = computeEffectivePolicy(
        cfg,
        entry.kind === 'page' ? undefined : entry.declaration.options,
        entry.scopes,
      )
      policy =
        effective.bodyLimit === cfg.bodyLimit &&
        effective.cors === cfg.cors &&
        effective.csrf === cfg.csrf
          ? applicationPolicy
          : compilePolicy(effective)
      routePolicies.set(entry, policy)
    }
    return policy
  }

  function policiesFor(ctx: Context): RequestPolicies {
    const cached = requestPolicies.get(ctx)
    if (cached) return cached
    const cfg = getConfig()
    const { defaultPolicy } = getPoliciesForConfig(cfg)
    let selected = defaultPolicy
    let selectedEntry: RouteEntry | undefined
    for (const route of matchedRoutes(ctx)) {
      const entry = handlerToEntry.get(route.handler)
      if (entry) {
        selected = getRoutePolicy(cfg, entry)
        selectedEntry = entry
        break
      }
    }
    const target = preflightMethod(ctx.req.raw)
    let preflightPolicy: RequestPolicy | undefined
    if (target) {
      const [matches] = methodRouter.match(target, ctx.req.path)
      if (matches && matches.length > 0) {
        preflightPolicy = getRoutePolicy(cfg, matches[0][0].entry)
      }
    }
    const policies: RequestPolicies = {
      selectedEntry,
      route: selected,
      preflight: preflightPolicy,
    }
    requestPolicies.set(ctx, policies)
    return policies
  }

  let canonicalizer: RouteCanonicalizer | undefined

  function pageClient(ctx: Context) {
    const instance = instanceProvider?.()
    if (!instance || apiPrefix === undefined) {
      throw new Error('Page dispatch requires an application instance and resolved API prefix.')
    }
    const origin = new URL(ctx.req.url).origin
    const prefix = apiPrefix === '/' ? '' : apiPrefix
    return createClient({
      baseUrl: `${origin}${prefix}`,
      async fetch(request) {
        const target = new URL(request.url)
        if (
          target.origin !== origin ||
          (prefix && target.pathname !== prefix && !target.pathname.startsWith(prefix + '/'))
        ) {
          return fetch(request)
        }
        const headers = new Headers(request.headers)
        for (const name of ['cookie', 'authorization', 'origin']) {
          const value = ctx.req.header(name)
          if (value !== undefined && !headers.has(name)) headers.set(name, value)
        }
        const response = await instance.fetchInternal(new Request(request, { headers }))
        captureResponsePolicy(ctx, response)
        return response
      },
    })
  }

  const getPath = (request: Request): string => {
    let pathname = getRequestPath(request)

    if (pathname.length > 1 && pathname.endsWith('/')) {
      pathname = pathname.slice(0, -1)
    }

    const currentConfig = getConfig()
    if (!currentConfig.caseSensitive) {
      const canonical = (canonicalizer ??= createRouteCanonicalizer(orderedRoutes)).findCanonical(
        pathname,
        preflightMethod(request) ?? request.method,
      )
      if (canonical) {
        pathname = canonical
      }
    }

    return pathname
  }

  const preparedRoutes = orderedRoutes.map((entry) => {
    const indexed = { method: entry.routePath.method, entry }
    methodRouter.add(entry.routePath.method, entry.routePath.urlPath, indexed)
    methodRouter.add(METHOD_INDEX, entry.routePath.urlPath, indexed)
    if (entry.routePath.method === 'GET') methodRouter.add('HEAD', entry.routePath.urlPath, indexed)
    const handler: MiddlewareHandler = async (ctx) => {
      const output =
        entry.kind === 'page'
          ? await entry.pageHandler(
              ctx,
              pageClient(ctx),
              getCurrentScope() as RequestScope,
              getConfig().production,
            )
          : await entry.declaration.handler(
              ctx,
              await parseAndValidateInput(ctx, entry.declaration.validators),
            )
      if (output instanceof Response && !ctx.finalized) preserveResponseCookies(ctx, output)
      if (ctx.req.method === 'HEAD' && output instanceof Response && output.body) {
        try {
          await output.body.cancel()
        } catch (error) {
          getLogger().warn('HEAD response body cancellation failed', { error })
        }
      }
      const response = formatResponse(output, ctx.req.raw, ctx.res.headers)
      const vary = response.headers.get('Vary')
      if (vary) ctx.header('Vary', vary)
      return response
    }
    handlerToEntry.set(handler, entry)
    return { ...entry, handler }
  })

  const app = new Hono({ getPath })
  app.use('*', requestContext(getConfig, instanceProvider))

  // Register CORS ahead of all rejections, using the selected route's own parameter context.
  const preflightPaths = new Set(orderedRoutes.map((r) => r.routePath.urlPath))
  for (const entry of orderedRoutes) {
    const { routePath } = entry
    app.on([routePath.method], [routePath.urlPath], (ctx, next) => {
      if (preflightMethod(ctx.req.raw)) return next()
      const policies = policiesFor(ctx)
      if (policies.selectedEntry !== entry) return next()
      const cors = policies.route.cors
      return cors ? cors(ctx, next) : next()
    })
  }
  for (const path of preflightPaths) {
    app.options(path, (ctx, next) => {
      const selected = policiesFor(ctx).preflight
      return selected?.cors ? selected.cors(ctx, next) : next()
    })
  }
  app.use('*', (ctx, next) => {
    const policies = policiesFor(ctx)
    if (policies.preflight) {
      return policies.preflight.cors ? policies.preflight.cors(ctx, next) : next()
    }
    const { defaultPolicy } = getPoliciesForConfig(getConfig())
    if (policies.route !== defaultPolicy) return next()
    return defaultPolicy.cors ? defaultPolicy.cors(ctx, next) : next()
  })
  app.use('*', async (ctx, next) => {
    const instance = instanceProvider?.()
    const scope = getCurrentScope()
    const currentConfig = getConfig()
    const acceptedInternal =
      instance?.state === 'draining' && scope?.isInternal && !scope.signal?.aborted
    if (instance && instance.state !== 'ready' && !acceptedInternal) {
      throw new HttpError(503, 'Application is shutting down', { code: 'application_draining' })
    }
    const requestUrl = new URL(ctx.req.url)
    const publicUrl = new URL(scope!.externalOrigin!)
    publicUrl.pathname = requestUrl.pathname
    publicUrl.search = requestUrl.search
    const redirectUrl = checkUrlNormalization(
      publicUrl,
      ctx.req.method,
      currentConfig.trailingSlash,
      ctx.req.path,
    )
    if (redirectUrl) return ctx.redirect(redirectUrl, 308)
    return next()
  })

  // Centralized error boundary
  app.onError((err: unknown, ctx: Context) => {
    const errorResponse = formatErrorResponse(err, getConfig().production)
    const vary = errorResponse.headers.get('Vary')
    if (vary) ctx.header('Vary', vary)
    return preserveResponseCookies(ctx, errorResponse)
  })

  app.use('*', bindRequestServices)

  // Resolve policies before business middleware; overlapping routes do not stack their policies.
  for (const entry of orderedRoutes) {
    const { routePath } = entry
    app.on([routePath.method], [routePath.urlPath], (ctx, next) => {
      const policies = policiesFor(ctx)
      if (policies.selectedEntry !== entry) return next()
      const admission = policies.route.admission
      return admission ? admission(ctx, next) : next()
    })
  }

  // Application-level middleware executes with effective request configuration
  const combinedMiddlewareCache = new WeakMap<ResolvedHttpConfig, MiddlewareHandler | null>()

  function getCombinedMiddleware(cfg: ResolvedHttpConfig): MiddlewareHandler | null {
    let cached = combinedMiddlewareCache.get(cfg)
    if (cached === undefined) {
      const middlewares = cfg.middleware
      if (middlewares.length === 0) {
        cached = null
      } else {
        cached = every(...middlewares.map(preserveMiddlewareCookies))
      }
      combinedMiddlewareCache.set(cfg, cached)
    }
    return cached
  }

  app.use('*', async (ctx, next) => {
    const combined = getCombinedMiddleware(getConfig())
    if (!combined) {
      return next()
    }
    return combined(ctx, next)
  })

  for (const entry of preparedRoutes) {
    const { routePath, handler, scopes } = entry
    const scopeMiddlewares = (scopes ?? [])
      .map((s) => s.middleware)
      .filter((m): m is MiddlewareHandler => typeof m === 'function')
    const routeMiddlewares = entry.kind === 'page' ? [] : entry.declaration.options.middleware
    const allMiddlewares = [...scopeMiddlewares, ...routeMiddlewares].map(preserveMiddlewareCookies)

    app.on([routePath.method], [routePath.urlPath], ...allMiddlewares, handler)
  }

  // Fallback 405 and 404 handler via Hono TrieRouter
  app.all('*', async (ctx: Context) => {
    const reqPath = ctx.req.path
    const reqMethod = ctx.req.method.toUpperCase()

    // A path may have API and page handlers with different methods.
    const [matches] = methodRouter.match(METHOD_INDEX, reqPath)
    if (matches && matches.length > 0) {
      const allowedMethods = new Set<string>()
      for (const [route] of matches) {
        allowedMethods.add(route.method)
        if (route.method === 'GET') allowedMethods.add('HEAD')
      }

      if (!allowedMethods.has('ALL') && !allowedMethods.has(reqMethod)) {
        const allowMethods = Array.from(allowedMethods)
          .filter((m) => m !== 'ALL')
          .toSorted()
          .join(', ')

        return new Response(
          JSON.stringify({
            error: {
              code: 'method_not_allowed',
              message: `Method ${reqMethod} Not Allowed`,
            },
          }),
          {
            status: 405,
            headers: {
              'Content-Type': 'application/json; charset=utf-8',
              Allow: allowMethods,
            },
          },
        )
      }
    }

    const currentConfig = getConfig()
    const pagePath = currentConfig.caseSensitive ? reqPath : reqPath.toLowerCase()
    const webBase = currentConfig.caseSensitive ? webPrefix : webPrefix?.toLowerCase()
    // Unknown website requests use the root error document, without layout loaders.
    if (
      page404Handler &&
      webBase !== undefined &&
      (webBase === '/' || pagePath === webBase || pagePath.startsWith(webBase + '/')) &&
      (reqMethod === 'GET' || reqMethod === 'HEAD') &&
      ctx.req.header('accept')?.includes('text/html')
    ) {
      const scope = getCurrentScope() as RequestScope
      const client = pageClient(ctx)
      const notFoundRes = await page404Handler(ctx, client, scope, currentConfig.production)
      if (notFoundRes) return notFoundRes
    }

    return new Response(
      JSON.stringify({
        error: {
          code: 'not_found',
          message: `Cannot ${reqMethod} ${reqPath}`,
        },
      }),
      {
        status: 404,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
        },
      },
    )
  })

  if (typeof config !== 'function') {
    getPoliciesForConfig(config)
    for (const entry of orderedRoutes) getRoutePolicy(config, entry)
  }
  return app
}
