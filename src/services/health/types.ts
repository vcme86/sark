/**
 * Application health checking and probe declaration contracts.
 *
 * @module
 */

import type { BaseDeclaration } from '../../core/declaration'
import type { Logger } from '../../core/logging'
import type { Register } from '../../core/types'

type RegisteredResources = Register extends { resources: infer R } ? R : {}

/** Context supplied to an individual health check execution. */
export type HealthCheckContext<TResources = RegisteredResources> = {
  /** Signal aborted if the health check execution times out. */
  readonly signal: AbortSignal
  /** Dedicated logger scoped to the health check category. */
  readonly logger: Logger
} & TResources

/** Function performing a single dependency check. */
export type HealthCheck = (ctx: HealthCheckContext) => Promise<unknown> | unknown

/** Configuration for Node.js health probes and dependency readiness checks. */
export interface HealthConfig {
  /** Named readiness checks evaluating downstream dependencies. */
  readiness?: Record<string, HealthCheck>
  /** Timeout in milliseconds per health check execution (defaults to 1000). */
  timeout?: number
  /** Duration in milliseconds to cache successful readiness check results (defaults to 2000). */
  cache?: number
  /** Independent admission check on the incoming request (returns 401 on false). */
  auth?: (request: Request) => boolean | Promise<boolean>
}

/** Declaration representing configured health checks. */
export type HealthDeclaration = BaseDeclaration<'health', HealthConfig>

/** Resolved and validated configuration for health probes and readiness checks. */
export interface ResolvedHealthConfig {
  readonly readiness: Readonly<Record<string, HealthCheck>>
  readonly timeout: number
  readonly cache: number
  readonly auth?: (request: Request) => boolean | Promise<boolean>
}
