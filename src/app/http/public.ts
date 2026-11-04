/** Common request processing for host-owned files and probes, without business bindings. */
import type { MiddlewareHandler } from 'hono'

import { cors } from '../../middleware/cors'
import type { ResolvedHttpConfig } from '../config'
import { applicationLifecycles } from '../lifecycle'
import { type ExecutionLogging, getLogger } from '../logging'
import type { AppInstance } from '../types'
import { requestDeliveries, trackResponseCompletion } from './delivery'
import { requestContext, responseMetadata } from './request-context'

/**
 * Applies source checks, request IDs, CORS and access completion to a selected public response.
 *
 * @param config - Resolved application HTTP policy.
 * @param logging - Selected output hooks; no business services are created.
 * @param instance - Node instance whose lifetime includes the delivery, absent for standalone assets.
 * @returns Middleware for a host-owned endpoint, outside business admission.
 */
export function publicRequest(
  config: ResolvedHttpConfig,
  logging?: ExecutionLogging,
  instance?: AppInstance<any>,
): MiddlewareHandler {
  const context = requestContext(() => config, instance ? () => instance : undefined)
  const corsPolicy = config.cors === false ? undefined : cors(config.cors)
  return async (ctx, next) => {
    const start = performance.now()
    const lifecycle = instance && applicationLifecycles.get(instance)
    lifecycle?.beginRequest()
    try {
      await context(ctx, async () => {
        if (corsPolicy) await corsPolicy(ctx, next)
        else await next()
      })
      if (!logging?.recordAccess && !lifecycle) return
      const meta = responseMetadata.get(ctx.res)!
      const record = (status: number | undefined, outcome: 'ok' | 'error' | 'aborted') =>
        logging?.recordAccess?.(
          {
            method: ctx.req.method,
            url: ctx.req.url,
            requestId: meta.requestId,
            clientIp: meta.clientIp,
          },
          status,
          performance.now() - start,
          outcome,
        )
      const delivery = requestDeliveries.get(ctx.req.raw)
      if (delivery) {
        void delivery
          .then(({ status, outcome }) => record(status, outcome))
          .finally(() => {
            lifecycle?.endRequest()
          })
          .catch((error) =>
            getLogger().error('Public response completion failed: {error}', { error }),
          )
      } else {
        ctx.res = trackResponseCompletion(ctx.res, (outcome) => {
          try {
            record(ctx.res.status, outcome)
          } finally {
            lifecycle?.endRequest()
          }
        })
      }
    } catch (error) {
      lifecycle?.endRequest()
      throw error
    }
  }
}
