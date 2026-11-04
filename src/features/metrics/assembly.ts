/** Node metrics preparation and host-owned process collection. */
import { collectDefaultMetrics, Registry } from '@prometheus-io/client'

import type { EnvironmentRequirement } from '../../app/declaration'
import type { SystemEndpoint } from '../../app/http/assembly'
import type {
  RequestBindingContext,
  ServiceAssembly,
  ServiceCreateContext,
  ServicePreparation,
} from '../../app/service'
import { resolveMetricsConfig } from './declaration'
import { PrometheusMetrics } from './service'
import type { MetricsDeclaration, MetricsService, ResolvedMetricsConfig } from './types'

// Process observers belong to the Node host, including across application replacement.
let processRegistry: Registry | undefined

/**
 * Declares instance-owned metrics preparation without starting collectors.
 *
 * @param declaration - Node metrics settings or environment factory.
 * @returns Assembly preparing one configuration, endpoint and registry per application.
 */
export function createMetricsAssembly<T extends MetricsDeclaration>(
  declaration: T,
): ServiceAssembly<MetricsService> & EnvironmentRequirement<readonly [T]>
export function createMetricsAssembly(
  declaration: MetricsDeclaration,
): ServiceAssembly<MetricsService> {
  return {
    expose: true,
    createRuntime: () => ({ prepare: (env) => prepareMetrics(declaration, env) }),
  }
}

/** Resolves configuration before route compilation or resource creation. */
function prepareMetrics(
  declaration: MetricsDeclaration,
  env: unknown,
): ServicePreparation<MetricsService> {
  const config = resolveMetricsConfig(declaration, env)
  return {
    endpoints: [createMetricsEndpoint(config)],
    create: (_resources, context) => createMetricsService(config, context),
  }
}

/** The endpoint runs after public checks and before application middleware or request bindings. */
function createMetricsEndpoint(config: ResolvedMetricsConfig): SystemEndpoint {
  return {
    path: config.path,
    method: 'GET',
    async handle(ctx, scope) {
      ctx.header('Cache-Control', 'no-store')
      if (config.auth && !(await config.auth(ctx.req.raw))) {
        return new Response('Unauthorized', {
          status: 401,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        })
      }
      const service = scope.services!.metrics as PrometheusMetrics
      const output = config.runtime
        ? Registry.merge([service.registry, processRegistry!])
        : service.registry
      return new Response(await output.metrics(), {
        headers: { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' },
      })
    },
  }
}

/** Creates application metrics and registers only their owned cleanup. */
function createMetricsService(config: ResolvedMetricsConfig, context: ServiceCreateContext) {
  if (context.target !== 'node') throw new Error('Prometheus metrics require a Node.js host.')
  const registry = new Registry()
  if (config.runtime && !processRegistry) {
    processRegistry = new Registry()
    collectDefaultMetrics({
      register: processRegistry,
      eventLoopMonitoringPrecision: config.eventLoopPrecision,
      gcDurationBuckets: [...config.gcDurationBuckets],
    })
  }
  const service = new PrometheusMetrics(registry, config)
  context.registerDispose('metrics', () => registry.clear())
  return {
    service,
    observer: service,
    createBinding({ ctx }: RequestBindingContext) {
      ctx.set('metrics', service)
      return {}
    },
  }
}
