/**
 * Node host declarations for listening, runtime directory mounts, and health checks.
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
