import type { MiddlewareHandler } from 'hono'

import { getCurrentScope } from '../app/context'
import {
  type CompressionOptions,
  resolveCompression,
  type ResolvedCompressionOptions,
} from './compression'
export type { CompressionOptions } from './compression'

/**
 * Associates raw requests with policies read by the Node delivery layer.
 * Keeping options in memory preserves filter functions and regular expressions.
 */
export const requestCompressionPolicies = new WeakMap<Request, ResolvedCompressionOptions | false>()

/**
 * Declares the compression policy for the current request.
 *
 * Policy rules:
 * - Node applies compression once at the response delivery boundary.
 * - Later explicit middleware overrides earlier compression settings for the request.
 * - Workers skip this middleware and leave compression to the platform.
 * - Options remain in memory; the middleware does not add control headers.
 *
 * @param options - False disables compression; true or omission selects default gzip settings;
 *   an options object supplies explicit settings. All forms override the Node runtime default.
 * @returns Middleware recording the request policy before continuing downstream.
 */
export function compress(options?: CompressionOptions | boolean): MiddlewareHandler {
  const resolved = resolveCompression(options)
  return async (ctx, next) => {
    const isWorkers =
      typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers'
    if (isWorkers) {
      return next()
    }

    requestCompressionPolicies.set(getCurrentScope()?.request ?? ctx.req.raw, resolved)
    return next()
  }
}
