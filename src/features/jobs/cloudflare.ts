/**
 * Cloudflare Workers scheduled task dispatching, timeout handling, and failure propagation.
 *
 * @module
 */

import type {
  CloudflareExecutionContext,
  ScheduledController,
} from '../../adapter/cloudflare/types'
import { getCurrentScope, runInScope } from '../../app/context'
import { dispatchApplicationEvent } from '../../app/create'
import { getLogger } from '../../app/logging'
import type { AppInstance } from '../../app/types'
import { resolveJobsDeclaration } from './declaration'
import type { JobContext, JobsDeclaration, ResolvedCloudflareJobDefinition } from './types'

/**
 * Selects task configuration before opening event resources.
 *
 * @param declaration - Static jobs or an event environment factory.
 * @returns A scheduled handler preserving resource, logging, and platform event lifetimes.
 */
export function createCloudflareJobsHandler(declaration: JobsDeclaration) {
  let staticJobs: readonly ResolvedCloudflareJobDefinition[] | undefined
  return (
    controller: ScheduledController,
    env: unknown,
    context: CloudflareExecutionContext,
    instance: AppInstance<any>,
  ): Promise<void> => {
    const jobs = declaration.isFactory
      ? resolveJobsDeclaration(declaration, env, 'cloudflare')
      : (staticJobs ??= resolveJobsDeclaration(declaration, env, 'cloudflare'))
    return dispatchApplicationEvent(instance, env, context, () =>
      dispatchCloudflareJobs(jobs, controller, env, context, instance),
    )
  }
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
  jobDefs: readonly ResolvedCloudflareJobDefinition[],
  controller: ScheduledController,
  env: unknown,
  ctx: CloudflareExecutionContext,
  instance: AppInstance<any>,
): Promise<void> {
  const matchingJobs = jobDefs.filter((job) => job.onCron === controller.cron)

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
        const scope = {
          ...parentScope,
          app: instance,
          requestId: crypto.randomUUID(),
          signal: abortController.signal,
          env,
          executionCtx: ctx,
        }

        let timeoutTimer: ReturnType<typeof setTimeout> | undefined
        if (job.timeout !== undefined) {
          timeoutTimer = setTimeout(() => {
            runInScope(scope, () => {
              const timeoutErr = new Error(`Job "${job.name}" timed out after ${job.timeout}ms`)
              jobLogger.warn(`Job "${job.name}" timed out: ${timeoutErr}`, {
                error: timeoutErr,
              })
              abortController.abort(timeoutErr)
            })
          }, job.timeout)
        }

        const jobContext: JobContext = {
          name: job.name,
          signal: abortController.signal,
          logger: jobLogger,
          ...parentScope?.resources,
          ...(parentScope?.services?.cache ? { cache: parentScope.services.cache } : {}),
        }

        try {
          await runInScope(scope, async () => {
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
          })
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
