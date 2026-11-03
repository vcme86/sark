/**
 * Node.js background jobs manager with Croner scheduling, fixed delays, execution sets, and deadline budget.
 *
 * @module
 */

import { Cron } from 'croner'

import { runInScope } from '../../core/context'
import type { ShutdownContext } from '../../core/lifecycle'
import { getLogger } from '../../core/logging'
import type { ServiceReadyContext } from '../../core/service'
import type { AppInstance } from '../../core/types'
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
  readonly shutdown: ShutdownContext
}

export interface NodeJobsManagerInstance extends JobsManager {
  readonly isDraining: boolean
  start(context: ServiceReadyContext): void
  drain(deadline?: number): void
}

async function waitExecutionsWithBudget(
  name: string,
  executions: Set<Promise<void>>,
  controllers: Set<AbortController>,
  deadline: number,
  reserveMs: number,
): Promise<void> {
  if (executions.size === 0) return

  const now = performance.now()
  const totalRemaining = deadline - now

  if (totalRemaining <= 0) {
    const timeoutErr = new Error(`Job "${name}" close budget exceeded shutdown deadline`)
    for (const ctrl of controllers) {
      ctrl.abort(timeoutErr)
    }
    throw timeoutErr
  }

  // Phase 1: Graceful wait until deadline - reserve
  const gracefulMs = Math.max(0, totalRemaining - reserveMs)

  let gracefulTimer: ReturnType<typeof setTimeout> | undefined
  const gracefulExpired = new Promise<'timeout'>((resolve) => {
    gracefulTimer = setTimeout(() => resolve('timeout'), gracefulMs)
  })

  const settlePromise = Promise.allSettled(Array.from(executions)).then(() => 'settled' as const)
  const firstOutcome = await Promise.race([settlePromise, gracefulExpired])
  if (gracefulTimer) clearTimeout(gracefulTimer)

  if (firstOutcome === 'settled') {
    return
  }

  // Phase 2: Graceful window expired -> issue abort signal and wait in reserve phase
  const cancelErr = new Error(
    `Job "${name}" exceeded graceful drain budget (${Math.round(gracefulMs)}ms); aborting in-flight tasks`,
  )
  for (const ctrl of controllers) {
    ctrl.abort(cancelErr)
  }

  const remainingReserve = Math.max(0, deadline - performance.now())
  let reserveTimer: ReturnType<typeof setTimeout> | undefined
  const reserveExpired = new Promise<'timeout'>((resolve) => {
    reserveTimer = setTimeout(() => resolve('timeout'), remainingReserve)
  })

  const secondOutcome = await Promise.race([settlePromise, reserveExpired])
  if (reserveTimer) clearTimeout(reserveTimer)

  // If in-flight executions settled within reserve window after aborting, throw cancelErr because graceful budget was exceeded
  if (secondOutcome === 'settled') {
    throw cancelErr
  }

  // Still active after total deadline exceeded
  const timeoutErr = new Error(
    `Job "${name}" close timed out after ${Math.round(totalRemaining)}ms`,
  )
  throw timeoutErr
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
    const preventOverlap = job.preventOverlap
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
      if (preventOverlap && activeExecutions.size > 0) {
        jobLogger.warn(`Job "${job.name}" skipped: previous execution still in progress`)
        return
      }

      const taskId = crypto.randomUUID()
      const abortController = new AbortController()
      activeControllers.add(abortController)

      const onSignalAbort = () => abortController.abort(signal.reason)
      if (signal.aborted) onSignalAbort()
      else signal.addEventListener('abort', onSignalAbort, { once: true })

      let timeoutTimer: ReturnType<typeof setTimeout> | undefined
      if (job.timeout && job.timeout > 0) {
        timeoutTimer = setTimeout(() => {
          void runInScope(
            {
              app: currentInstance,
              requestId: taskId,
              signal: abortController.signal,
              resources: currentResources,
              services: currentServices,
              env: currentEnv,
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
        ...currentResources,
      }

      const currentExecution = runInScope(
        {
          app: currentInstance,
          requestId: taskId,
          signal: abortController.signal,
          resources: currentResources,
          services: currentServices,
          env: currentEnv,
        },
        async () => {
          const startTime = performance.now()
          jobLogger.info(`Job "${job.name}" started`)
          try {
            await job.handler(jobContext)
            const durationMs = Math.round(performance.now() - startTime)
            jobLogger.info(`Job "${job.name}" completed in ${durationMs}ms`)
          } catch (error) {
            const durationMs = Math.round(performance.now() - startTime)
            jobLogger.error(`Job "${job.name}" failed after ${durationMs}ms: ${error}`, {
              error,
            })
            if (isManual) throw error
          } finally {
            if (timeoutTimer) clearTimeout(timeoutTimer)
            signal.removeEventListener('abort', onSignalAbort)
            activeControllers.delete(abortController)
          }
        },
      )

      activeExecutions.add(currentExecution)
      waitUntil?.(currentExecution)
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
          await execute(false)
        } finally {
          if (!stopped && !paused && !isDraining) {
            scheduleIntervalNext()
          }
        }
      }, intervalMs)
    }

    function stopTriggers(): void {
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

    startCallbacks.push(() => {
      if (stopped || isDraining) return
      if (isInterval) {
        if (job.runOnInit) {
          queueMicrotask(async () => {
            try {
              await execute(false)
            } finally {
              if (!stopped && !paused && !isDraining) {
                scheduleIntervalNext()
              }
            }
          })
        } else {
          scheduleIntervalNext()
        }
      } else {
        cronInstance = new Cron(
          job.schedule as string,
          {
            timezone: job.timezone,
            protect: preventOverlap
              ? (_j) => {
                  jobLogger.warn(
                    `Job "${job.name}" skipped: previous cron execution still in progress`,
                  )
                }
              : false,
            catch: (error) => {
              jobLogger.error(`Unhandled Cron error in job "${job.name}": ${error}`, {
                error,
              })
            },
            paused: false,
          },
          async () => {
            await execute(false)
          },
        )

        if (job.runOnInit) {
          queueMicrotask(() => {
            void execute(false)
          })
        }
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
