/**
 * Prometheus metric recording, service, and configuration contracts.
 *
 * @module
 */

import type { BaseDeclaration } from '../../app/declaration'

/** Base specification describing a Prometheus metric. */
export interface MetricSpec {
  /** Metric identifier following Prometheus naming conventions. */
  name: string
  /** Human-readable explanation of the metric purpose. */
  help: string
  /** Dimension label names. Every recording call must supply all declared labels. */
  labels?: string[]
}

/** Specification for a Prometheus histogram metric. */
export interface HistogramSpec extends MetricSpec {
  /** Explicit upper bounds for histogram buckets. */
  buckets?: number[]
}

/** Increment-only counter metric. */
export interface Counter {
  /** Increments by a non-negative value, defaulting to 1; declared labels are required. */
  inc(labels?: Record<string, string>, value?: number): void
}

/** Duration or size observation histogram. */
export interface Histogram {
  /** Records an observed value within appropriate bucket boundaries. */
  observe(value: number, labels?: Record<string, string>): void
}

/** Point-in-time value gauge metric. */
export interface Gauge {
  /** Sets the current instantaneous value. */
  set(value: number, labels?: Record<string, string>): void
  /** Increments the gauge by value (defaults to 1). */
  inc(labels?: Record<string, string>, value?: number): void
  /** Decrements the gauge by value (defaults to 1). */
  dec(labels?: Record<string, string>, value?: number): void
}

/** Application metrics service for registering and recording metrics. */
export interface MetricsService {
  /** Registers or reuses a counter; incompatible types or labels throw. */
  counter(spec: MetricSpec): Counter
  /** Registers or reuses a histogram; incompatible types, labels, or buckets throw. */
  histogram(spec: HistogramSpec): Histogram
  /** Registers or reuses a gauge; incompatible types or labels throw. */
  gauge(spec: MetricSpec): Gauge
}

/** Configuration options for the Node Prometheus metrics service. */
export interface MetricsConfig {
  /** Metrics endpoint path. Defaults to '/metrics'. */
  readonly path?: string
  /** Whether to collect Node.js runtime process metrics. Defaults to true. */
  readonly runtime?: boolean
  /** Default histogram buckets for HTTP request duration in seconds. */
  readonly buckets?: readonly number[]
  /** Event loop monitoring precision in milliseconds. Defaults to 10. */
  readonly eventLoopPrecision?: number
  /** GC duration histogram buckets in seconds. */
  readonly gcDurationBuckets?: readonly number[]
  /** Optional authorization check for the configured endpoint; false returns HTTP 401. */
  readonly auth?: (request: Request) => boolean | Promise<boolean>
}

/** Metrics settings retained until the owning instance is prepared. */
export interface MetricsDeclaration extends BaseDeclaration<'metrics', MetricsConfig> {}

/** Validated settings shared by endpoint creation and metric collection. */
export interface ResolvedMetricsConfig {
  readonly path: string
  readonly runtime: boolean
  readonly buckets: readonly number[]
  readonly eventLoopPrecision: number
  readonly gcDurationBuckets: readonly number[]
  readonly auth?: (request: Request) => boolean | Promise<boolean>
}
