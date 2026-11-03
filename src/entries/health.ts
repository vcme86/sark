/**
 * Application health checking and probe configuration exports.
 *
 * @module
 */

export { defineHealth } from '../services/health/declaration'
export type {
  HealthCheck,
  HealthCheckContext,
  HealthConfig,
  HealthDeclaration,
} from '../services/health/types'
