/**
 * Declaration factory and configuration resolution for Prometheus metrics.
 *
 * @module
 */

import { evaluateDeclaration, type RequiresEnv } from '../../app/declaration'
import { resolveStaticPath } from '../../http/url'
import type { MetricsConfig, MetricsDeclaration, ResolvedMetricsConfig } from './types'

const DEFAULT_REQUEST_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] as const

const DEFAULT_GC_BUCKETS = [0.001, 0.01, 0.1, 1, 2, 5] as const

const DEFAULT_METRICS_PATH = '/metrics'
const DEFAULT_EVENT_LOOP_PRECISION = 10

/**
 * Declares the application's Prometheus metrics service configuration.
 *
 * @param config - Endpoint, runtime observation, and histogram bucket settings.
 * @returns A declaration evaluated when assembling the metrics service.
 */
export function defineMetrics(config?: MetricsConfig): MetricsDeclaration
/**
 * Declares metrics settings resolved from the environment.
 *
 * @param factory - Configuration factory evaluated during assembly.
 * @returns A declaration preserving the factory's environment requirements.
 */
export function defineMetrics<E>(
  factory: (env: E) => MetricsConfig,
): MetricsDeclaration & RequiresEnv<E>
export function defineMetrics<E>(
  input?: MetricsConfig | ((env: E) => MetricsConfig),
): MetricsDeclaration {
  return {
    kind: 'metrics',
    value: input === undefined ? {} : input,
    isFactory: typeof input === 'function',
  }
}

/**
 * Resolves and validates metrics options against the host environment.
 *
 * @param declaration - Declared metrics configuration or factory.
 * @param env - Loaded environment.
 * @returns Fully validated and normalized metrics settings.
 * @throws {Error} If the endpoint path, bucket boundaries, or monitoring precision are invalid.
 */
export function resolveMetricsConfig(
  declaration: MetricsDeclaration,
  env: unknown,
): ResolvedMetricsConfig {
  const raw = evaluateDeclaration<MetricsConfig>(declaration.value, env, 'metrics')

  const path = resolveStaticPath(raw.path ?? DEFAULT_METRICS_PATH, 'Metrics path')

  const runtime = raw.runtime ?? true
  const buckets = raw.buckets ? [...raw.buckets] : [...DEFAULT_REQUEST_BUCKETS]
  const gcDurationBuckets = raw.gcDurationBuckets
    ? [...raw.gcDurationBuckets]
    : [...DEFAULT_GC_BUCKETS]
  const eventLoopPrecision = raw.eventLoopPrecision ?? DEFAULT_EVENT_LOOP_PRECISION

  for (const bucket of buckets) {
    if (!Number.isFinite(bucket) || bucket <= 0) {
      throw new Error(
        `Invalid metrics bucket value: ${bucket}. All bucket values must be positive numbers.`,
      )
    }
  }

  for (const bucket of gcDurationBuckets) {
    if (!Number.isFinite(bucket) || bucket <= 0) {
      throw new Error(
        `Invalid gcDurationBuckets value: ${bucket}. All bucket values must be positive numbers.`,
      )
    }
  }

  if (!Number.isFinite(eventLoopPrecision) || eventLoopPrecision <= 0) {
    throw new Error('eventLoopPrecision must be a positive number.')
  }

  return {
    path,
    runtime,
    buckets,
    eventLoopPrecision,
    gcDurationBuckets,
    auth: raw.auth,
  }
}
