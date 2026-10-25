/**
 * Node liveness and readiness probes outside the business request pipeline.
 *
 * @module
 */

import type { Hono } from 'hono'

import type { ApplicationDefinition } from '../../core/definition'
import type { AppInstance } from '../../core/types'
import { requestContext } from '../../web/http/server/request-context'

/**
 * Mounts probes outside business admission.
 *
 * Probe responses:
 * - Liveness: HTTP 200 independent of application state, after common request checks.
 * - Readiness: HTTP 200 only in the ready state; HTTP 503 in all other states.
 * - A false probesConfig disables both endpoints.
 *
 * @param hono - Delivery layer Hono application.
 * @param instance - Active Sark application instance with assembled route metadata.
 * @param probesConfig - Configured endpoint paths or `false` to disable probes.
 * @throws If an enabled probe conflicts with a business endpoint.
 */
export function mountNodeProbes(
  hono: Hono<any>,
  instance: AppInstance<ApplicationDefinition>,
  probesConfig: false | { liveness: string; readiness: string },
): void {
  if (probesConfig === false) {
    return
  }

  const { liveness, readiness } = probesConfig
  const normalize = (path: string) => {
    const value = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
    return instance.config.caseSensitive ? value : value.toLowerCase()
  }
  for (const [name, path] of Object.entries(probesConfig)) {
    const conflict = instance.definition.routes.find(
      ({ routePath }) =>
        (routePath.method === 'GET' || routePath.method === 'ALL') &&
        normalize(routePath.urlPath) === normalize(path),
    )
    if (conflict) {
      throw new Error(
        `Route conflict: Node ${name} probe GET ${path} conflicts with ${conflict.source ?? `${conflict.routePath.method} ${conflict.routePath.urlPath}`}.`,
      )
    }
  }

  const context = requestContext(
    () => instance.config,
    () => instance,
  )

  hono.get(liveness, context, (ctx) => {
    return ctx.json({ status: 'ok' }, 200)
  })

  hono.get(readiness, context, (ctx) => {
    if (instance.state !== 'ready') {
      return ctx.json({ status: instance.state }, 503)
    }
    return ctx.json({ status: 'ok' }, 200)
  })
}
