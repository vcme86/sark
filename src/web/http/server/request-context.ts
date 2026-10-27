/**
 * HTTP execution scope initialization, proxy resolution, and response headers.
 *
 * @module
 */

import type { Context, MiddlewareHandler } from 'hono'

import { getCurrentScope, type RequestScope, runInScope } from '../../../core/context'
import { applicationLifecycles } from '../../../core/lifecycle'
import type { RequestBindingContext, ServiceBinding } from '../../../core/service'
import type { AppInstance } from '../../../core/types'
import type { ResolvedHttpConfig } from '../config'
import {
  matchesCompiledRules,
  resolveClientIp,
  resolveExternalOrigin,
  validateHost,
} from '../proxy'
import { formatErrorResponse, preserveResponseCookies } from './output'

function getPeerIp(ctx: Context, isWorkers: boolean): string {
  if (isWorkers) {
    return (
      ctx.req.header('cf-connecting-ip') ||
      ((ctx.req.raw as unknown as { cf?: { connectingIp?: string } }).cf?.connectingIp ?? '')
    )
  }

  const env = ctx.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined
  const socketIp = env?.incoming?.socket?.remoteAddress
  if (socketIp) return socketIp

  return ''
}

/**
 * Applies request identity and configured headers while preserving the response body stream.
 *
 * @param response - Final response from the request pipeline or an earlier configuration failure.
 * @param config - Effective configuration, or baseline settings if factory resolution failed.
 * @param requestId - Identifier assigned to this request.
 * @returns A response with writable headers and the original status and body.
 */
export function applyResponseHeaders(
  response: Response,
  config: ResolvedHttpConfig,
  requestId: string,
): Response {
  const headers = new Headers(response.headers)
  headers.set('X-Request-Id', requestId)
  applyConfiguredHeaders(headers, config)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

function applyConfiguredHeaders(headers: Headers, config: ResolvedHttpConfig): void {
  if (config.headers === false) return
  for (const [key, value] of Object.entries(config.headers)) {
    if (value === false) headers.delete(key)
    else if (!headers.has(key)) headers.set(key, value)
  }
}

/**
 * Creates request-scoped state, validates hosts, resolves proxy addresses, and applies response headers.
 * Domain bindings are initialized inside the scope before downstream middleware runs.
 * Header-commit hooks finish before the Cookie collector is sealed, including SSR's early commit.
 *
 * @param getConfig - Getter returning the owning instance or event configuration.
 * @param instanceProvider - Lazy accessor returning the current application instance.
 * @returns Hono middleware handler.
 */
export function requestContext(
  getConfig: () => ResolvedHttpConfig,
  instanceProvider?: () => AppInstance | undefined,
): MiddlewareHandler {
  return async (ctx, next) => {
    const rawReq = ctx.req.raw
    const reqUrl = new URL(ctx.req.url)

    const instance = instanceProvider?.()
    const parent = getCurrentScope()
    const isInternal = parent?.app === instance && parent?.isInternal === true
    const shutdownSignal = instance && applicationLifecycles.get(instance)?.signal

    const rawEnv = ctx.env
    const isNodeServerEnv =
      rawEnv && typeof rawEnv === 'object' && ('incoming' in rawEnv || 'outgoing' in rawEnv)
    const env = isNodeServerEnv ? parent?.env : (rawEnv ?? parent?.env)
    const executionCtx = parent?.executionCtx

    const effectiveConfig = getConfig()

    const isWorkers =
      (typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers') ||
      Boolean(executionCtx)
    const peerIp = getPeerIp(ctx, isWorkers)
    const compiledProxies = effectiveConfig.proxyRules

    const forwardedId = isWorkers
      ? ctx.req.header('cf-ray')
      : matchesCompiledRules(peerIp, compiledProxies)
        ? ctx.req.header('x-request-id')
        : undefined
    const requestId = isInternal
      ? parent.requestId
      : forwardedId ||
        (parent && parent.app === instance ? parent.requestId : undefined) ||
        crypto.randomUUID()

    const requestSignal =
      !isWorkers && shutdownSignal
        ? AbortSignal.any([rawReq.signal, shutdownSignal])
        : rawReq.signal

    let headersCommitted = false
    const serviceBindings: Record<string, ServiceBinding> = {}
    const isHeadersCommitted = () =>
      headersCommitted || Boolean(isInternal && parent.isHeadersCommitted?.())
    ctx.set('requestId', requestId)
    try {
      validateHost(ctx.req.header('host') || reqUrl.host, effectiveConfig.hosts)
      const inherited = isInternal ? (parent as RequestScope) : undefined
      const scope = {
        requestId,
        request: rawReq,
        app: instance,
        isInternal,
        clientIp: inherited
          ? inherited.clientIp
          : resolveClientIp(rawReq.headers, peerIp, compiledProxies) || '127.0.0.1',
        externalOrigin: inherited
          ? inherited.externalOrigin
          : resolveExternalOrigin(reqUrl, rawReq.headers, peerIp, compiledProxies).origin,
        signal: requestSignal,
        appendCookies(cookies) {
          if (cookies.length && isHeadersCommitted())
            throw new Error(
              'Cannot forward API cookies after response headers have been committed.',
            )
          for (const cookie of cookies) ctx.header('Set-Cookie', cookie, { append: true })
        },
        async commitResponseHeaders() {
          if (headersCommitted) return
          for (const binding of Object.values(serviceBindings)) await binding.onCommitHeaders?.()
          headersCommitted = true
        },
        isHeadersCommitted,
        dedupStore: isInternal ? parent.dedupStore : new Map(),
        config: effectiveConfig,
        pageConfig: parent?.pageConfig,
        resources: parent?.resources,
        services: parent?.services,
        serviceBindings,
        serviceBindingFactories: parent?.serviceBindingFactories,
        httpApp: parent?.httpApp,
        env,
        executionCtx,
      } satisfies RequestScope
      if (scope.resources) {
        for (const [key, val] of Object.entries(scope.resources)) {
          ctx.set(key, val)
        }
      }
      await runInScope(scope, async () => {
        for (const [name, factory] of Object.entries(parent?.serviceBindingFactories ?? {})) {
          const bindingContext: RequestBindingContext = {
            ctx,
            request: rawReq,
            signal: requestSignal,
            parentBinding: isInternal ? parent.serviceBindings?.[name] : undefined,
            appendCookie: (cookie) => scope.appendCookies([cookie]),
            isHeadersCommitted,
          }
          serviceBindings[name] = await factory(bindingContext)
        }
        await next()
        await scope.commitResponseHeaders()
      })
    } catch (error) {
      ctx.res = runInScope({ ...parent, requestId, app: instance }, () =>
        preserveResponseCookies(ctx, formatErrorResponse(error, effectiveConfig.production)),
      )
    }
    // Hono's setter merges old headers into a replacement Response, restoring deletions.
    // header() first makes the final response writable, including native fetch responses.
    ctx.header('X-Request-Id', requestId)
    applyConfiguredHeaders(ctx.res.headers, effectiveConfig)
    headersCommitted = true
  }
}
