/**
 * Cloudflare Workers scheduled task dispatching, timeout handling, and failure propagation.
 *
 * @module
 */

import type { CloudflareExecutionContext } from '../../adapter/cloudflare/runtime'
import { getCurrentScope, runInScope } from '../../core/context'
import { getLogger } from '../../core/logging'
import type { AppInstance } from '../../core/types'
import { assertUniqueJobNames } from './declaration'
import type { CloudflareJobDefinition, JobContext, JobDefinition } from './types'

export interface ScheduledController {
  readonly scheduledTime: number
  readonly cron: string
  noRetry(): void
}

/**
 * Dispatches a Cloudflare Workers scheduled event to registered jobs matching `controller.cron`.
 *
 * @param jobDefs - All declared jobs for the application.
 * @param controller - Scheduled event controller containing the platform cron string.
 * @param env - Platform bindings for this event.
 * @param ctx - Cloudflare execution context providing waitUntil.
 * @param instance - Assembled application instance.
 * @throws If no job matches `controller.cron`, or if one or more handlers fail.
 */
export async function dispatchCloudflareJobs(
  jobDefs: readonly JobDefinition[],
  controller: ScheduledController,
  env: unknown,
  ctx: CloudflareExecutionContext,
  instance: AppInstance<any>,
  effectiveCrons?: readonly string[],
): Promise<void> {
  assertUniqueJobNames(jobDefs)

  for (const job of jobDefs) {
    if (
      (job as any).schedule !== undefined ||
      (job as any).timezone !== undefined ||
      (job as any).preventOverlap !== undefined ||
      (job as any).runOnInit !== undefined
    ) {
      throw new Error(
        `Job "${job.name}" declares Node-specific options (schedule, timezone, preventOverlap, or runOnInit) not supported on Cloudflare Workers.`,
      )
    }
    if (typeof (job as CloudflareJobDefinition).onCron !== 'string') {
      throw new Error(`Job "${job.name}" must specify onCron on Cloudflare Workers.`)
    }
  }

  if (effectiveCrons !== undefined) {
    if (effectiveCrons.length === 0) {
      throw new Error(
        'Cloudflare Workers target requires triggers.crons in Wrangler configuration when background jobs are declared.',
      )
    }

    const declaredCrons = new Set<string>()
    for (const job of jobDefs) {
      const onCron = (job as CloudflareJobDefinition).onCron!
      if (!effectiveCrons.includes(onCron)) {
        throw new Error(
          `Scheduled job "${job.name}" specifies onCron "${onCron}" which is not declared in triggers.crons.`,
        )
      }
      declaredCrons.add(onCron)
    }

    for (const cron of effectiveCrons) {
      if (!declaredCrons.has(cron)) {
        throw new Error(`Configured trigger "${cron}" has no matching scheduled job.`)
      }
    }

    if (!effectiveCrons.includes(controller.cron)) {
      throw new Error(`Received cron "${controller.cron}" is not declared in triggers.crons.`)
    }
  }

  const matchingJobs: CloudflareJobDefinition[] = []

  for (const job of jobDefs) {
    if ((job as CloudflareJobDefinition).onCron === controller.cron) {
      matchingJobs.push(job as CloudflareJobDefinition)
    }
  }

  if (matchingJobs.length === 0) {
    throw new Error(`No scheduled job matched cron "${controller.cron}".`)
  }

  const parentScope = getCurrentScope()

  const runAll = async () => {
    const failures: unknown[] = []

    await Promise.all(
      matchingJobs.map(async (job) => {
        const jobLogger = getLogger(`jobs:${job.name}`)
        const abortController = new AbortController()
        const taskId = crypto.randomUUID()

        let timeoutTimer: ReturnType<typeof setTimeout> | undefined
        if (job.timeout && job.timeout > 0) {
          timeoutTimer = setTimeout(() => {
            void runInScope(
              {
                ...parentScope,
                app: instance,
                requestId: taskId,
                signal: abortController.signal,
                env,
                executionCtx: ctx,
              },
              () => {
                const timeoutErr = new Error(`Job "${job.name}" timed out after ${job.timeout}ms`)
                jobLogger.warn(`Job "${job.name}" timed out: ${timeoutErr}`, {
                  error: timeoutErr,
                })
                abortController.abort(timeoutErr)
              },
            )
          }, job.timeout)
        }

        const jobContext: JobContext = {
          name: job.name,
          signal: abortController.signal,
          logger: jobLogger,
          ...parentScope?.resources,
        }

        try {
          await runInScope(
            {
              ...parentScope,
              app: instance,
              requestId: taskId,
              signal: abortController.signal,
              env,
              executionCtx: ctx,
            },
            async () => {
              const startTime = performance.now()
              jobLogger.info(`Job "${job.name}" started on cron "${controller.cron}"`)
              try {
                await job.handler(jobContext)
                const durationMs = Math.round(performance.now() - startTime)
                jobLogger.info(`Job "${job.name}" completed in ${durationMs}ms`)
              } catch (error) {
                const durationMs = Math.round(performance.now() - startTime)
                jobLogger.error(`Job "${job.name}" failed after ${durationMs}ms: ${error}`, {
                  error,
                })
                failures.push(error)
              }
            },
          )
        } finally {
          if (timeoutTimer) clearTimeout(timeoutTimer)
        }
      }),
    )

    if (failures.length === 1) {
      throw failures[0]
    }
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        `Multiple scheduled jobs failed for cron "${controller.cron}".`,
      )
    }
  }

  const aggregatePromise = runAll()
  ctx.waitUntil(aggregatePromise)
  await aggregatePromise
}
