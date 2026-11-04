/**
 * Background jobs and scheduled tasks configuration and contracts.
 *
 * @module
 */

import type { BaseDeclaration } from '../../app/declaration'
import type { Logger } from '../../app/logging'
import type { Register } from '../../app/types'
import type { ScopedStatsService, StatsService } from '../stats/types'

type RegisteredResources = Register extends { resources: infer R } ? R : {}

/** Instance services available outside an HTTP request; excludes request-bound identities. */
type RegisteredJobServices = Register extends { services: infer S }
  ? Pick<S, Extract<keyof S, 'cache' | 'metrics'>> &
      ('stats' extends keyof S
        ? {
            readonly stats: S['stats'] extends ScopedStatsService<infer C>
              ? StatsService<C>
              : StatsService
          }
        : {})
  : {}

/** Execution context supplied to a background job handler. */
export type JobContext<TResources = RegisteredResources> = {
  /** Name of the executing job. */
  readonly name: string
  /** Cancellation signal triggered on application drain, timeout, or explicit stop. */
  readonly signal: AbortSignal
  /** Dedicated logger for the job with structured properties. */
  readonly logger: Logger
} & TResources &
  RegisteredJobServices

/** Job schedule: either a 5-part cron pattern or a fixed delay in milliseconds. */
export type JobSchedule = string | { readonly interval: number }

/** Base definition common to Node and Cloudflare jobs. */
export interface BaseJobDefinition<TContext extends JobContext = JobContext> {
  /** Unique name of the job. */
  readonly name: string
  /** Handler function performing the job work. */
  readonly handler: (ctx: TContext) => void | Promise<void>
  /** Optional execution timeout in milliseconds. */
  readonly timeout?: number
}

/** Node.js job definition supporting cron expressions and interval delays. */
export interface NodeJobDefinition<
  TContext extends JobContext = JobContext,
> extends BaseJobDefinition<TContext> {
  /** Schedule expressed as a 5-part cron pattern or `{ interval: number }` (milliseconds). */
  readonly schedule: JobSchedule
  /** Timezone name (defaults to process timezone). Cron 0 and 7 both represent Sunday. */
  readonly timezone?: string
  /** Prevents execution if the previous invocation is still active (defaults to true). */
  readonly preventOverlap?: boolean
  /** Invokes the job once immediately after application startup readiness (defaults to false). */
  readonly runOnInit?: boolean
  readonly onCron?: never
}

/** Cloudflare Workers scheduled task definition matching ScheduledController.cron. */
export interface CloudflareJobDefinition<
  TContext extends JobContext = JobContext,
> extends BaseJobDefinition<TContext> {
  /** Raw cron string matching Cloudflare Workers ScheduledController.cron. */
  readonly onCron: string
  readonly schedule?: never
  readonly timezone?: never
  readonly preventOverlap?: never
  readonly runOnInit?: never
}

/** Resolved Node.js job definition with normalized defaults. */
export interface ResolvedNodeJobDefinition<
  TContext extends JobContext = JobContext,
> extends BaseJobDefinition<TContext> {
  readonly schedule: JobSchedule
  readonly timezone?: string
  readonly preventOverlap: boolean
  readonly runOnInit: boolean
  readonly onCron?: never
}

/** Resolved Cloudflare Workers scheduled task definition. */
export interface ResolvedCloudflareJobDefinition<
  TContext extends JobContext = JobContext,
> extends BaseJobDefinition<TContext> {
  readonly onCron: string
  readonly schedule?: never
  readonly timezone?: never
  readonly preventOverlap?: never
  readonly runOnInit?: never
}

/** Discriminated union of background job definitions. */
export type JobDefinition<TContext extends JobContext = JobContext> =
  | NodeJobDefinition<TContext>
  | CloudflareJobDefinition<TContext>

/** Controller handle for an individual Node.js scheduled job. */
export interface JobHandle {
  /** Unique name of the job. */
  readonly name: string
  /** Pauses future scheduled triggers without cancelling active executions. */
  pause(): void
  /** Resumes scheduled triggers. */
  resume(): void
  /**
   * Permanently stops scheduling and waits for in-flight tasks to complete within budget.
   *
   * @returns Resolves after in-flight execution finishes within the graceful budget.
   * @throws If cancellation is required or the total budget expires.
   */
  stop(): Promise<void>
  /**
   * Runs the job immediately, respecting overlap protection.
   *
   * @returns Resolves when manual execution completes or skips due to overlap protection.
   * @throws If the job handler throws or rejects.
   */
  run(): Promise<void>
  /** Indicates whether the job handler is currently executing. */
  isExecuting(): boolean
}

/** Runtime manager exposing job handles and coordinated shutdown. */
export interface JobsManager {
  /** Retrieves a job handle by its declared name. */
  get(name: string): JobHandle | undefined
  /** Returns a list of all managed job handles. */
  list(): readonly JobHandle[]
  /**
   * Stops all job triggers and drains running tasks within the deadline budget.
   *
   * @param deadline - Host shutdown deadline on the performance.now() clock.
   */
  close(deadline?: number): Promise<void>
}

/** Declaration representing application-level background jobs. */
export type JobsDeclaration<E = any> = BaseDeclaration<
  'jobs',
  readonly JobDefinition[] | ((env: E) => readonly JobDefinition[])
>
