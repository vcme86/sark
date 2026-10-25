/**
 * HTTP execution scope initialization, proxy resolution, and response headers.
 *
 * @module
 */

import type { Context, MiddlewareHandler } from 'hono'

import { type ExecutionScope, getCurrentScope, runInScope } from '../../../core/context'
import { applicationLifecycles } from '../../../core/lifecycle'
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
  if (config.headers !== false) {
    for (const [key, value] of Object.entries(config.headers)) {
      if (value === false) headers.delete(key)
      else if (!headers.has(key)) headers.set(key, value)
    }
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

/**
 * Creates request-scoped state, validates hosts, resolves proxy addresses, and applies response headers.
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

    const scope = {
      requestId,
      app: instance,
      isInternal,
      clientIp: undefined as string | undefined,
      externalOrigin: undefined as string | undefined,
      signal: requestSignal,
      appendCookies(cookies) {
        for (const cookie of cookies) ctx.header('Set-Cookie', cookie, { append: true })
      },
      dedupStore: isInternal ? parent.dedupStore : new Map(),
      config: effectiveConfig,
      env,
      executionCtx,
    } satisfies ExecutionScope
    return runInScope(scope, async () => {
      ctx.set('requestId', requestId)
      try {
        validateHost(ctx.req.header('host') || reqUrl.host, effectiveConfig.hosts)
        scope.clientIp = isInternal
          ? parent.clientIp
          : resolveClientIp(rawReq.headers, peerIp, compiledProxies) || '127.0.0.1'
        scope.externalOrigin = isInternal
          ? parent.externalOrigin
          : resolveExternalOrigin(reqUrl, rawReq.headers, peerIp, compiledProxies).origin
        await next()
      } catch (error) {
        ctx.res = preserveResponseCookies(
          ctx,
          formatErrorResponse(error, effectiveConfig.production),
        )
      }
      ctx.res = applyResponseHeaders(ctx.res, effectiveConfig, requestId)
    })
  }
}
