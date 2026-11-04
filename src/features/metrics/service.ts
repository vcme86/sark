/**
 * Prometheus metrics service implementation backed by @prometheus-io/client.
 *
 * @module
 */

import {
  Counter as PromCounter,
  Gauge as PromGauge,
  Histogram as PromHistogram,
  type Registry,
} from '@prometheus-io/client'

import type { ExecutionObserver } from '../../app/service'
import type {
  Counter,
  Gauge,
  Histogram,
  HistogramSpec,
  MetricSpec,
  MetricsService,
  ResolvedMetricsConfig,
} from './types'

type RegisteredEntry =
  | { kind: 'counter'; spec: MetricSpec; metric: Counter }
  | { kind: 'histogram'; spec: HistogramSpec; metric: Histogram }
  | { kind: 'gauge'; spec: MetricSpec; metric: Gauge }

/** Application metrics service instance backed by a per-application Prometheus registry. */
export class PrometheusMetrics implements MetricsService, ExecutionObserver {
  readonly registry: Registry
  private readonly registered = new Map<string, RegisteredEntry>()

  // Framework-owned built-in metrics
  private readonly httpRequestsTotal: Counter
  private readonly httpRequestDuration: Histogram
  private readonly httpActiveRequests: Gauge
  private readonly wsConnectionsActive: Gauge
  private readonly jobsRunsTotal: Counter
  private readonly jobsRunning: Gauge
  private readonly jobsSkippedTotal: Counter

  constructor(registry: Registry, config: ResolvedMetricsConfig) {
    this.registry = registry

    this.httpRequestsTotal = this.counter({
      name: 'http_requests_total',
      help: 'Total number of HTTP requests processed',
      labels: ['method', 'route', 'status'],
    })

    this.httpRequestDuration = this.histogram({
      name: 'http_request_duration_seconds',
      help: 'Duration of HTTP requests in seconds',
      labels: ['method', 'route'],
      buckets: [...config.buckets],
    })

    this.httpActiveRequests = this.gauge({
      name: 'http_active_requests',
      help: 'Number of currently active HTTP requests',
    })

    this.wsConnectionsActive = this.gauge({
      name: 'ws_connections_active',
      help: 'Number of currently active WebSocket connections',
    })

    this.jobsRunsTotal = this.counter({
      name: 'jobs_runs_total',
      help: 'Total number of background job executions',
      labels: ['job', 'result'],
    })

    this.jobsRunning = this.gauge({
      name: 'jobs_running',
      help: 'Number of currently running background jobs',
      labels: ['job'],
    })

    this.jobsSkippedTotal = this.counter({
      name: 'jobs_skipped_total',
      help: 'Total number of skipped background job executions',
      labels: ['job'],
    })
  }

  counter(spec: MetricSpec): Counter {
    const normalizedName = normalizeCounterName(spec.name)
    const existing = this.findExisting(spec.name)
    if (existing) {
      if (existing.kind !== 'counter') {
        throw new Error(`Metric conflict: "${spec.name}" already registered as a ${existing.kind}.`)
      }
      if (!areLabelsEqual(existing.spec.labels, spec.labels)) {
        throw new Error(`Metric conflict: "${spec.name}" re-declared with different labels.`)
      }
      return existing.metric
    }

    const labelNames = spec.labels ? [...spec.labels] : []
    const clientCounter = new PromCounter({
      name: normalizedName,
      help: spec.help,
      labelNames,
      registers: [this.registry],
    })

    const wrapper: Counter = {
      inc(labels, value = 1) {
        const validated = validateLabels(normalizedName, labelNames, labels)
        clientCounter.inc(validated ?? {}, value)
      },
    }

    const entry: RegisteredEntry = {
      kind: 'counter',
      spec: { ...spec, labels: labelNames },
      metric: wrapper,
    }
    this.registered.set(normalizedName, entry)
    this.registered.set(spec.name, entry)
    return wrapper
  }

  histogram(spec: HistogramSpec): Histogram {
    const existing = this.findExisting(spec.name)
    if (existing) {
      if (existing.kind !== 'histogram') {
        throw new Error(`Metric conflict: "${spec.name}" already registered as a ${existing.kind}.`)
      }
      if (!areLabelsEqual(existing.spec.labels, spec.labels)) {
        throw new Error(`Metric conflict: "${spec.name}" re-declared with different labels.`)
      }
      if (!areBucketsEqual(existing.spec.buckets, spec.buckets)) {
        throw new Error(`Metric conflict: "${spec.name}" re-declared with different buckets.`)
      }
      return existing.metric
    }

    const labelNames = spec.labels ? [...spec.labels] : []
    const clientHistogram = new PromHistogram({
      name: spec.name,
      help: spec.help,
      labelNames,
      buckets: spec.buckets,
      registers: [this.registry],
    })

    const wrapper: Histogram = {
      observe(value, labels) {
        const validated = validateLabels(spec.name, labelNames, labels)
        clientHistogram.observe(validated ?? {}, value)
      },
    }

    const entry: RegisteredEntry = {
      kind: 'histogram',
      spec: { ...spec, labels: labelNames, buckets: spec.buckets && [...spec.buckets] },
      metric: wrapper,
    }
    this.registered.set(spec.name, entry)
    return wrapper
  }

  gauge(spec: MetricSpec): Gauge {
    const existing = this.findExisting(spec.name)
    if (existing) {
      if (existing.kind !== 'gauge') {
        throw new Error(`Metric conflict: "${spec.name}" already registered as a ${existing.kind}.`)
      }
      if (!areLabelsEqual(existing.spec.labels, spec.labels)) {
        throw new Error(`Metric conflict: "${spec.name}" re-declared with different labels.`)
      }
      return existing.metric
    }

    const labelNames = spec.labels ? [...spec.labels] : []
    const clientGauge = new PromGauge({
      name: spec.name,
      help: spec.help,
      labelNames,
      registers: [this.registry],
    })

    const wrapper: Gauge = {
      set(value, labels) {
        const validated = validateLabels(spec.name, labelNames, labels)
        clientGauge.set(validated ?? {}, value)
      },
      inc(labels, value = 1) {
        const validated = validateLabels(spec.name, labelNames, labels)
        clientGauge.inc(validated ?? {}, value)
      },
      dec(labels, value = 1) {
        const validated = validateLabels(spec.name, labelNames, labels)
        clientGauge.dec(validated ?? {}, value)
      },
    }

    this.registered.set(spec.name, {
      kind: 'gauge',
      spec: { ...spec, labels: labelNames },
      metric: wrapper,
    })
    return wrapper
  }

  onRequestStart(): void {
    this.httpActiveRequests.inc()
  }

  onRequestEnd(
    method: string,
    route: string | undefined,
    status: number | undefined,
    duration: number,
  ): void {
    this.httpActiveRequests.dec()
    const labels = { method, route: route ?? '/*' }
    this.httpRequestsTotal.inc({
      ...labels,
      status: status === undefined ? 'unknown' : String(status),
    })
    this.httpRequestDuration.observe(duration / 1000, labels)
  }

  onSocketOpen(): void {
    this.wsConnectionsActive.inc()
  }

  onSocketClose(): void {
    this.wsConnectionsActive.dec()
  }

  onJobStart(name: string): void {
    this.jobsRunning.inc({ job: name })
  }

  onJobEnd(name: string, result: 'success' | 'error'): void {
    this.jobsRunning.dec({ job: name })
    this.jobsRunsTotal.inc({ job: name, result })
  }

  onJobSkip(name: string): void {
    this.jobsSkippedTotal.inc({ job: name })
  }

  private findExisting(name: string): RegisteredEntry | undefined {
    return this.registered.get(name) ?? this.registered.get(normalizeCounterName(name))
  }
}

/**
 * Normalizes Counter metric names to always include the standard `_total` suffix.
 *
 * @param name - Original metric name.
 * @returns Metric name ending with `_total`.
 */
function normalizeCounterName(name: string): string {
  return name.endsWith('_total') ? name : `${name}_total`
}

/**
 * Validates that all required labels declared in the spec are supplied at call time.
 *
 * @param name - Metric name for diagnostic reporting.
 * @param declaredLabels - Expected label keys.
 * @param labels - Supplied label map.
 * @returns The supplied labels, leaving unknown-label and value validation to the SDK.
 * @throws {Error} If a required label is missing.
 */
function validateLabels(
  name: string,
  declaredLabels: readonly string[],
  labels: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (declaredLabels.length === 0) {
    return labels
  }
  if (!labels) {
    throw new Error(
      `Metric "${name}" requires labels [${declaredLabels.join(', ')}], but none were provided.`,
    )
  }
  for (const label of declaredLabels) {
    if (labels[label] === undefined) {
      throw new Error(`Metric "${name}" missing required label: "${label}".`)
    }
  }
  return labels
}

/** Checks whether two arrays of numbers are equivalent. */
function areBucketsEqual(a?: number[], b?: number[]): boolean {
  if (a === b) return true
  if (!a || !b || a.length !== b.length) return false
  return a.every((val, i) => val === b[i])
}

/** Checks whether two label arrays contain the exact same set of names. */
function areLabelsEqual(a?: string[], b?: string[]): boolean {
  const setA = new Set(a ?? [])
  const setB = new Set(b ?? [])
  if (setA.size !== setB.size) return false
  for (const item of setA) {
    if (!setB.has(item)) return false
  }
  return true
}
