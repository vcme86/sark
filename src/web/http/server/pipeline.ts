/**
 * HTTP middleware composition, route admission, dispatch, and error responses.
 *
 * @module
 */

import { type Context, Hono, type MiddlewareHandler } from 'hono'
import { bodyLimit as honoBodyLimit } from 'hono/body-limit'
import { every } from 'hono/combine'
import { matchedRoutes } from 'hono/route'
import { TrieRouter } from 'hono/router/trie-router'

import { getCurrentScope } from '../../../core/context'
import type { AppInstance } from '../../../core/types'
import type { ResolvedHttpConfig } from '../config'
import { HttpError } from '../error'
import { cors as sarkCors } from '../middleware/cors'
import { csrf as sarkCsrf } from '../middleware/csrf'
import {
  checkUrlNormalization,
  compareRoutes,
  createRouteCanonicalizer,
  type ParsedRoutePath,
} from '../path'
import type { RouteDeclaration, RouteOptions } from '../types'
import { parseAndValidateInput } from './input'
import {
  formatErrorResponse,
  formatResponse,
  preserveMiddlewareCookies,
  preserveResponseCookies,
} from './output'
import { computeEffectivePolicy, type RouteScope } from './policy'
export type { RouteScope } from './policy'
import { requestContext } from './request-context'

/** Parsed route entry pairing URL path metadata with its runtime handler declaration. */
export interface RouteEntry {
  /** Source module path included in assembly diagnostics when available. */
  readonly source?: string
  /** Parsed URL structure and HTTP method constraints. */
  readonly routePath: ParsedRoutePath
  /** Route declaration holding validation schemas, middleware, and handler. */
  readonly declaration: RouteDeclaration
  /** Ordered chain of ancestor directory scopes applying to this route. */
  readonly scopes?: readonly RouteScope[]
}

interface RequestPolicy {
  cors?: MiddlewareHandler
  admission?: MiddlewareHandler
  maxBodySize: number | false
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

function compilePolicy(
  cfg: ResolvedHttpConfig,
  options?: Pick<RouteOptions, 'bodyLimit' | 'cors' | 'csrf'>,
  scopes?: readonly RouteScope[],
): RequestPolicy {
  const effective = computeEffectivePolicy(cfg, options, scopes)
  const csrf = effective.csrf === false ? undefined : sarkCsrf(effective.csrf)
  const bodyLimit =
    effective.bodyLimit === false
      ? undefined
      : honoBodyLimit({
          maxSize: effective.bodyLimit,
          onError: () => {
            throw new HttpError(413, 'Payload Too Large')
          },
        })
  let admission = csrf ?? bodyLimit
  if (csrf && bodyLimit) {
    admission = async (ctx, next) => {
      let response: Response | void = undefined
      const result = await csrf(ctx, async () => {
        response = await bodyLimit(ctx, next)
      })
      // CSRF awaits next(); preserve a response returned by the body limit.
      return result ?? response
    }
  }
  return {
    cors: effective.cors === false ? undefined : sarkCors(effective.cors),
    admission,
    maxBodySize: effective.bodyLimit,
  }
}

/**
 * Builds the HTTP pipeline with policies selected for the winning route.
 * Route policy overrides replace defaults rather than stacking with them.
 *
 * Request order:
 * 1. Establish the execution scope, request ID, and response cookie collector.
 * 2. Apply the selected CORS policy, including target-method preflight handling.
 * 3. Check lifecycle admission and GET/HEAD URL normalization.
 * 4. Apply the selected route's CSRF and body-limit policies.
 * 5. Run application middleware, then route middleware.
 * 6. Parse declared inputs, execute the handler, and format its response.
 * 7. Resolve unhandled paths as HTTP 404 or method mismatches as HTTP 405 with Allow.
 *
 * CORS precedes admission so rejections retain applicable CORS headers. Request
 * context middleware applies security headers after downstream execution returns.
 *
 * @param config - Resolved instance settings or a getter for the already resolved event settings.
 * @param routes - List of registered route entries.
 * @param instanceProvider - Lazy accessor returning the current application instance.
 * @returns Fully compiled Hono application instance.
 */
export function buildHttpApp(
  config: ResolvedHttpConfig | (() => ResolvedHttpConfig),
  routes: RouteEntry[],
  instanceProvider?: () => AppInstance | undefined,
): Hono<any> {
  const getConfig = typeof config === 'function' ? config : () => config
  const orderedRoutes = routes.toSorted((a, b) => compareRoutes(a.routePath, b.routePath))
  const handlerToEntry = new Map<object, RouteEntry>()
  const requestPolicies = new WeakMap<Context, RequestPolicies>()
  const methodRouter = new TrieRouter<IndexedRoute>()

  const policyCache = new WeakMap<
    ResolvedHttpConfig,
    {
      defaultPolicy: RequestPolicy
      routePolicies: Map<RouteEntry, RequestPolicy>
    }
  >()

  function getPoliciesForConfig(cfg: ResolvedHttpConfig) {
    let cached = policyCache.get(cfg)
    if (!cached) {
      cached = {
        defaultPolicy: compilePolicy(cfg, { csrf: false, bodyLimit: false }),
        routePolicies: new Map<RouteEntry, RequestPolicy>(),
      }
      policyCache.set(cfg, cached)
    }
    return cached
  }

  function getRoutePolicy(cfg: ResolvedHttpConfig, entry: RouteEntry): RequestPolicy {
    const { routePolicies } = getPoliciesForConfig(cfg)
    let policy = routePolicies.get(entry)
    if (!policy) {
      policy = compilePolicy(cfg, entry.declaration.options, entry.scopes)
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

  const canonicalizer = createRouteCanonicalizer(orderedRoutes)

  const getPath = (request: Request): string => {
    const url = new URL(request.url)
    let pathname = url.pathname

    if (pathname.length > 1 && pathname.endsWith('/')) {
      pathname = pathname.slice(0, -1)
    }

    const currentConfig = getConfig()
    if (!currentConfig.caseSensitive) {
      const canonical = canonicalizer.findCanonical(
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
      const currentPolicy = policiesFor(ctx).route
      const input = await parseAndValidateInput(
        ctx,
        entry.declaration.schemas,
        currentPolicy.maxBodySize,
      )
      const output = await entry.declaration.handler(ctx, input)
      if (output instanceof Response && !ctx.finalized) preserveResponseCookies(ctx, output)
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
        const adapted = middlewares.map(preserveMiddlewareCookies)
        cached = every(...adapted)
      }
      combinedMiddlewareCache.set(cfg, cached)
    }
    return cached
  }

  app.use('*', async (ctx, next) => {
    const currentConfig = getConfig()
    const combined = getCombinedMiddleware(currentConfig)
    if (!combined) {
      return next()
    }
    return combined(ctx, next)
  })

  for (const { routePath, declaration, handler, scopes } of preparedRoutes) {
    const scopeMiddlewares = (scopes ?? [])
      .map((s) => s.middleware)
      .filter((m): m is MiddlewareHandler => typeof m === 'function')
    const routeMiddlewares = declaration.options.middleware
    const allMiddlewares = [...scopeMiddlewares, ...routeMiddlewares].map(preserveMiddlewareCookies)

    app.on([routePath.method], [routePath.urlPath], ...allMiddlewares, handler)
  }

  // Fallback 405 and 404 handler via Hono TrieRouter
  app.all('*', (ctx: Context) => {
    const reqPath = ctx.req.path
    const reqMethod = ctx.req.method.toUpperCase()

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
