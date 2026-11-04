/**
 * Node.js background jobs manager with Croner scheduling, fixed delays, execution sets, and deadline budget.
 *
 * @module
 */

import { Cron } from 'croner'

import { waitUntil as waitForDeadline } from '../../adapter/node/deadline'
import { runInScope } from '../../app/context'
import type { ShutdownContext } from '../../app/lifecycle'
import { getLogger } from '../../app/logging'
import type { ExecutionObserver, ServiceReadyContext } from '../../app/service'
import type { AppInstance } from '../../app/types'
import type { JobContext, JobHandle, JobsManager, ResolvedNodeJobDefinition } from './types'

interface InternalJobHandle extends JobHandle {
  readonly activeExecutions: Set<Promise<void>>
  readonly activeControllers: Set<AbortController>
  stopTriggers(): void
  abortActive(reason?: unknown): void
}

export interface NodeJobsManagerOptions {
  readonly signal: AbortSignal
  readonly drainingSignal?: AbortSignal
  readonly env?: unknown
  readonly resources: Readonly<Record<string, unknown>>
  readonly waitUntil?: (promise: Promise<unknown>) => void
  readonly registerDispose: (name: string, dispose: () => void) => void
  readonly shutdown: ShutdownContext
}

export interface NodeJobsManagerInstance extends JobsManager {
  readonly isDraining: boolean
  start(context: ServiceReadyContext): void
  drain(deadline?: number): void
}

/**
 * Creates and initializes the Node.js background jobs manager.
 *
 * @param jobs - Declared Node job definitions.
 * @param options - Cancellation, lifecycle, logging and scope context.
 * @returns Initialized jobs manager coordinating scheduling and graceful draining.
 */
export function createNodeJobsManager(
  jobs: readonly ResolvedNodeJobDefinition[],
  options: NodeJobsManagerOptions,
): NodeJobsManagerInstance {
  const defaultLogger = getLogger('jobs')
  const { signal, drainingSignal, waitUntil } = options
  let currentInstance: AppInstance<any>

  const currentResources = options.resources
  let currentServices: Readonly<Record<string, unknown>>
  let observers: readonly ExecutionObserver[] | undefined
  const currentEnv = options.env

  const handles = new Map<string, InternalJobHandle>()
  const startCallbacks: Array<() => void> = []
  let isDraining = drainingSignal?.aborted ?? false
  let drainingDeadline: number | undefined
  let isStarted = false

  for (const job of jobs) {
    const isInterval = typeof job.schedule === 'object'

    let intervalTimer: ReturnType<typeof setTimeout> | undefined
    let cronInstance: Cron | undefined
    let paused = false
    let stopped = false
    let stopping: Promise<void> | undefined
    const activeExecutions = new Set<Promise<void>>()
    const activeControllers = new Set<AbortController>()
    const jobLogger = getLogger(`jobs:${job.name}`)

    async function execute(isManual = false): Promise<void> {
      if (stopped || isDraining) {
        throw new Error(`Job "${job.name}" cannot execute: application is draining.`)
      }
      if (paused && !isManual) {
        jobLogger.debug(`Job "${job.name}" skipped: scheduler is paused`)
        return
      }
      if (job.preventOverlap && activeExecutions.size > 0) {
        jobLogger.warn(`Job "${job.name}" skipped: previous execution still in progress`)
        if (observers) for (const observer of observers) observer.onJobSkip?.(job.name)
        return
      }

      const taskId = crypto.randomUUID()
      const abortController = new AbortController()
      activeControllers.add(abortController)
      const scope = {
        app: currentInstance,
        requestId: taskId,
        signal: abortController.signal,
        resources: currentResources,
        services: currentServices,
        env: currentEnv,
      }

      const onSignalAbort = () => abortController.abort(signal.reason)
      if (signal.aborted) onSignalAbort()
      else signal.addEventListener('abort', onSignalAbort, { once: true })

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
        ...currentResources,
        ...(currentServices.metrics ? { metrics: currentServices.metrics } : {}),
        ...(currentServices.cache ? { cache: currentServices.cache } : {}),
      }

      const currentExecution = runInScope(scope, async () => {
        const startTime = performance.now()
        if (observers) for (const observer of observers) observer.onJobStart?.(job.name)
        let result: 'success' | 'error' = 'success'
        jobLogger.info(`Job "${job.name}" started`)
        try {
          await job.handler(jobContext)
          const durationMs = Math.round(performance.now() - startTime)
          jobLogger.info(`Job "${job.name}" completed in ${durationMs}ms`)
        } catch (error) {
          const durationMs = Math.round(performance.now() - startTime)
          result = 'error'
          jobLogger.error(`Job "${job.name}" failed after ${durationMs}ms: ${error}`, {
            error,
          })
          if (isManual) throw error
        } finally {
          if (observers) for (const observer of observers) observer.onJobEnd?.(job.name, result)
          if (timeoutTimer) clearTimeout(timeoutTimer)
          signal.removeEventListener('abort', onSignalAbort)
          activeControllers.delete(abortController)
        }
      })

      activeExecutions.add(currentExecution)
      // The executor reports failures; lifetime tracking must not log them a second time.
      waitUntil?.(currentExecution.catch(() => {}))
      try {
        await currentExecution
      } finally {
        activeExecutions.delete(currentExecution)
      }
    }

    function scheduleIntervalNext(): void {
      if (stopped || paused || isDraining) return
      const intervalMs = (job.schedule as { interval: number }).interval
      intervalTimer = setTimeout(async () => {
        try {
          await runScheduled()
        } finally {
          if (!stopped && !paused && !isDraining) {
            scheduleIntervalNext()
          }
        }
      }, intervalMs)
    }

    function stopTriggers(): void {
      if (stopped) return
      stopped = true
      if (cronInstance) {
        cronInstance.stop()
      }
      if (intervalTimer) {
        clearTimeout(intervalTimer)
        intervalTimer = undefined
      }
    }

    function abortActive(reason?: unknown): void {
      for (const controller of activeControllers) {
        controller.abort(reason)
      }
    }

    const runScheduled = async () => {
      try {
        await execute(false)
      } catch (error) {
        jobLogger.error('Scheduled execution could not start: {error}', { error })
      }
    }
    if (!isInterval) {
      cronInstance = new Cron(
        job.schedule as string,
        {
          timezone: job.timezone,
          protect: false,
          paused: true,
          catch: (error) => jobLogger.error('Scheduler failed: {error}', { error }),
        },
        runScheduled,
      )
      options.registerDispose(`jobs:${job.name}`, stopTriggers)
    }
    startCallbacks.push(() => {
      if (stopped || paused || isDraining) return
      if (isInterval) {
        if (job.runOnInit)
          queueMicrotask(() => {
            void runScheduled().finally(scheduleIntervalNext)
          })
        else scheduleIntervalNext()
      } else {
        cronInstance!.resume()
        if (job.runOnInit)
          queueMicrotask(() => {
            void runScheduled()
          })
      }
    })

    const handle: InternalJobHandle = {
      name: job.name,
      activeExecutions,
      activeControllers,
      stopTriggers,
      abortActive,
      pause() {
        if (stopped || isDraining) return
        paused = true
        if (cronInstance) cronInstance.pause()
        if (intervalTimer) {
          clearTimeout(intervalTimer)
          intervalTimer = undefined
        }
      },
      resume() {
        if (stopped || isDraining) return
        paused = false
        if (cronInstance) cronInstance.resume()
        if (isInterval && !intervalTimer && activeExecutions.size === 0) {
          scheduleIntervalNext()
        }
      },
      stop() {
        stopTriggers()
        return (stopping ??= waitExecutionsWithBudget(
          job.name,
          activeExecutions,
          activeControllers,
          drainingDeadline ?? performance.now() + options.shutdown.budget.deadline,
          options.shutdown.budget.reserve,
        ))
      },
      run() {
        if (isDraining) {
          return Promise.reject(new Error(`Job "${job.name}" cannot run: application is draining.`))
        }
        return execute(true)
      },
      isExecuting() {
        return activeExecutions.size > 0
      },
    }

    handles.set(job.name, handle)
  }
  function drain(deadline?: number): void {
    isDraining = true
    const selectedDeadline =
      deadline ??
      options.shutdown.deadline ??
      drainingDeadline ??
      performance.now() + options.shutdown.budget.deadline
    drainingDeadline =
      drainingDeadline === undefined
        ? selectedDeadline
        : Math.min(drainingDeadline, selectedDeadline)
    defaultLogger.debug('Jobs manager is draining')
    for (const handle of handles.values()) {
      handle.stopTriggers()
    }
  }

  if (drainingSignal) {
    if (drainingSignal.aborted) drain()
    else drainingSignal.addEventListener('abort', () => drain(), { once: true })
  }

  const onSignalAbort = () => {
    drain()
    for (const handle of handles.values()) {
      handle.abortActive(signal.reason)
    }
  }
  if (signal.aborted) onSignalAbort()
  else signal.addEventListener('abort', onSignalAbort, { once: true })

  return {
    get isDraining() {
      return isDraining
    },
    get(name: string) {
      return handles.get(name)
    },
    list() {
      return Array.from(handles.values())
    },
    start(context) {
      if (isStarted || isDraining) return
      isStarted = true
      defaultLogger.debug('Jobs manager is starting')
      currentInstance = context.app
      currentServices = context.services
      observers = context.observers
      for (const start of startCallbacks) {
        start()
      }
    },
    drain,
    async close(deadline?: number) {
      defaultLogger.debug('Jobs manager is closing')
      drain(deadline)
      signal.removeEventListener('abort', onSignalAbort)

      // Trigger admission stopped in drain; only actual executions remain to be awaited.
      const allPromises = new Set<Promise<void>>()
      const allControllers = new Set<AbortController>()
      for (const h of handles.values()) {
        for (const p of h.activeExecutions) allPromises.add(p)
        for (const c of h.activeControllers) allControllers.add(c)
      }

      if (allPromises.size === 0) return

      await waitExecutionsWithBudget(
        'all',
        allPromises,
        allControllers,
        drainingDeadline!,
        options.shutdown.budget.reserve,
      )
    },
  }
}

/** Waits through graceful draining and cancellation without extending the shutdown deadline. */
async function waitExecutionsWithBudget(
  name: string,
  executions: Set<Promise<void>>,
  controllers: Set<AbortController>,
  deadline: number,
  reserveMs: number,
): Promise<void> {
  if (executions.size === 0) return

  const remaining = deadline - performance.now()
  if (remaining <= 0) {
    const error = new Error(`Job "${name}" close budget exceeded shutdown deadline`)
    for (const controller of controllers) controller.abort(error)
    throw error
  }

  // 1. Let active work settle before the cancellation reserve begins.
  const settled = Promise.allSettled(executions)
  if (await waitForDeadline(settled, deadline - reserveMs)) return

  // 2. Request cancellation, then wait for actual settlement within the remaining budget.
  const cancelError = new Error(
    `Job "${name}" exceeded graceful drain budget (${Math.round(Math.max(0, remaining - reserveMs))}ms); aborting in-flight tasks`,
  )
  for (const controller of controllers) controller.abort(cancelError)
  if (await waitForDeadline(settled, deadline)) throw cancelError

  throw new Error(`Job "${name}" close timed out after ${Math.round(remaining)}ms`)
}
