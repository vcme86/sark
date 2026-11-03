/**
 * Node liveness and readiness probes outside the business request pipeline.
 *
 * @module
 */

import type { Hono } from 'hono'

import { getApplicationRoutes } from '../../core/context'
import type { AppDefinition } from '../../core/definition'
import { applicationLifecycles } from '../../core/lifecycle'
import type { AppInstance } from '../../core/types'
import { requestContext } from '../../http/server/request-context'
import { resolveHealthConfig } from '../../services/health/declaration'
import { createHealthCheckRunner } from '../../services/health/runner'
import type { HealthDeclaration, ResolvedHealthConfig } from '../../services/health/types'

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
 * @param env - Host environment for declaration evaluation.
 * @throws If an enabled probe conflicts with a business endpoint.
 */
export function mountNodeProbes(
  hono: Hono<any>,
  instance: AppInstance<AppDefinition>,
  probesConfig: false | { liveness: string; readiness: string },
  env: unknown = process.env,
): void {
  const healthDecl = (instance.definition as unknown as { health?: HealthDeclaration }).health
  if (probesConfig === false) {
    if (healthDecl) {
      throw new Error(
        'Configuration conflict: health checks declared while runtime.probes is disabled.',
      )
    }
    return
  }

  let healthConfig: ResolvedHealthConfig | undefined
  if (healthDecl) {
    healthConfig = resolveHealthConfig(healthDecl, env)
  }

  const { liveness, readiness } = probesConfig
  const normalize = (path: string) => {
    const value = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
    return instance.config.caseSensitive ? value : value.toLowerCase()
  }
  for (const [name, path] of Object.entries(probesConfig)) {
    const conflict = getApplicationRoutes(instance).find(
      (route) =>
        (route.method === 'GET' || route.method === 'ALL') &&
        normalize(route.path) === normalize(path),
    )
    if (conflict) {
      const source = instance.definition.routes.find(
        ({ routePath }) =>
          routePath.method === conflict.method &&
          normalize(routePath.urlPath) === normalize(conflict.path),
      )?.source
      throw new Error(
        `Route conflict: Node ${name} probe GET ${path} conflicts with ${source ?? `${conflict.method} ${conflict.path}`}.`,
      )
    }
  }

  const context = requestContext(
    () => instance.config,
    () => instance,
  )

  const lifecycle = applicationLifecycles.get(instance)
  const runner = healthConfig
    ? createHealthCheckRunner(
        healthConfig,
        () => {
          const declared = instance.definition.resources ?? {}
          const result: Record<string, unknown> = {}
          for (const key of Object.keys(declared)) {
            result[key] = (instance as Record<string, unknown>)[key]
          }
          return result
        },
        {
          beginWork: () => lifecycle?.beginRequest(),
          endWork: () => lifecycle?.endRequest(),
          isDraining: () => lifecycle?.state === 'draining' || instance.state === 'draining',
        },
      )
    : undefined

  hono.get(liveness, context, async (ctx) => {
    if (healthConfig?.auth) {
      const authorized = await healthConfig.auth(ctx.req.raw)
      if (!authorized) {
        return ctx.text('Unauthorized', 401)
      }
    }
    return ctx.json({ status: 'ok' }, 200)
  })

  hono.get(readiness, context, async (ctx) => {
    if (healthConfig?.auth) {
      const authorized = await healthConfig.auth(ctx.req.raw)
      if (!authorized) {
        return ctx.text('Unauthorized', 401)
      }
    }
    if (instance.state !== 'ready') {
      return ctx.json({ status: instance.state }, 503)
    }
    if (runner) {
      const result = await runner.runReadiness()
      if (!result.ok) {
        return ctx.json({ status: 'unavailable', failed: result.failed }, 503)
      }
    }
    return ctx.json({ status: 'ok' }, 200)
  })
}
