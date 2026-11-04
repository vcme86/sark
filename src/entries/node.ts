/**
 * Node host declarations for listening, runtime directory mounts, health checks, and metrics.
 *
 * @module
 */

export {
  defineNodeRuntime,
  type NodeRuntimeConfig,
  type NodeRuntimeDeclaration,
  type CompressionOptions,
} from '../adapter/node/runtime'

export { defineAssets, type AssetMount, type AssetMountDeclaration } from '../adapter/node/mounts'

export { defineHealth } from '../features/health/declaration'
export type {
  HealthCheck,
  HealthCheckContext,
  HealthConfig,
  HealthDeclaration,
} from '../features/health/types'

export { defineMetrics } from '../features/metrics/declaration'
export type {
  Counter,
  Gauge,
  Histogram,
  HistogramSpec,
  MetricSpec,
  MetricsConfig,
  MetricsDeclaration,
  MetricsService,
} from '../features/metrics/types'
