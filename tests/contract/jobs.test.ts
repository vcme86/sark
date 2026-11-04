import { describe, expect, it } from 'vitest'

import { createWorkerHandler } from '../../src/adapter/cloudflare/runtime'
import { defineJobs } from '../../src/entries/jobs'
import { createApp } from '../../src/entries/root'
import { createDefinition } from '../../src/entries/runtime/core'
import { createNodeJobsAssembly } from '../../src/features/jobs/assembly-node'
import {
  createCloudflareJobsHandler,
  dispatchCloudflareJobs,
} from '../../src/features/jobs/cloudflare'
import { resolveJobsDeclaration } from '../../src/features/jobs/declaration'

describe('jobs contract', () => {
  it('schedules interval jobs, respects overlap protection, and supports JobHandle operations', async () => {
    let executionCount = 0
    let releaseWork!: () => void

    const jobsDecl = defineJobs([
      {
        name: 'interval-job',
        schedule: { interval: 20 },
        preventOverlap: true,
        handler: async () => {
          executionCount++
          await new Promise<void>((resolve) => {
            releaseWork = resolve
          })
        },
      },
    ])

    const app = await createApp(
      createDefinition({
        scheduled: createCloudflareJobsHandler(jobsDecl),
        services: {
          jobs: createNodeJobsAssembly(jobsDecl),
        },
      }),
    )

    const handle = app.jobs?.get('interval-job')
    expect(handle).toBeDefined()
    expect(handle?.name).toBe('interval-job')

    try {
      // Trigger execution manually
      const runPromise = handle!.run()
      expect(handle!.isExecuting()).toBe(true)

      // A concurrent trigger should be skipped due to overlap protection
      await handle!.run()
      expect(executionCount).toBe(1)

      // Release first execution
      releaseWork()
      await runPromise
      expect(handle!.isExecuting()).toBe(false)

      // Test pause and resume
      handle!.pause()
      // Wait past interval
      await new Promise((r) => setTimeout(r, 40))
      // Since it was paused, no new executions should have run
      expect(executionCount).toBe(1)

      // Resume
      handle!.resume()
      // Wait for interval to trigger
      await new Promise((r) => setTimeout(r, 50))
      expect(executionCount).toBe(2)
      releaseWork()
    } finally {
      await app.close()
    }
  })

  it('runs job on init when runOnInit is true', async () => {
    let ranOnInit = false

    const jobsDecl = defineJobs([
      {
        name: 'init-task',
        schedule: { interval: 10000 },
        runOnInit: true,
        handler: () => {
          ranOnInit = true
        },
      },
    ])

    const app = await createApp(
      createDefinition({
        services: {
          jobs: createNodeJobsAssembly(jobsDecl),
        },
      }),
    )

    try {
      // Allow microtask to run
      await new Promise((r) => setTimeout(r, 20))
      expect(ranOnInit).toBe(true)
    } finally {
      await app.close()
    }
  })

  it('retains overlap protection and isExecuting status when a job times out until it actually settles', async () => {
    let timedOutSignalReceived = false
    let handlerSettled = false

    const jobsDecl = defineJobs([
      {
        name: 'timeout-job',
        schedule: { interval: 5000 },
        timeout: 25, // 25ms timeout
        preventOverlap: true,
        handler: async ({ signal }) => {
          await new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => {
              timedOutSignalReceived = true
              // Simulating background work that takes another 50ms after cancellation
              setTimeout(() => {
                handlerSettled = true
                resolve()
              }, 50)
            })
          })
        },
      },
    ])

    const app = await createApp(
      createDefinition({
        services: {
          jobs: createNodeJobsAssembly(jobsDecl),
        },
      }),
    )

    const handle = app.jobs!.get('timeout-job')!

    try {
      const runPromise = handle.run()

      // Wait 35ms (timeout of 25ms has elapsed, abort signal fired)
      await new Promise((r) => setTimeout(r, 35))
      expect(timedOutSignalReceived).toBe(true)
      expect(handlerSettled).toBe(false)

      // Overlap protection must NOT be released early! isExecuting must still be true!
      expect(handle.isExecuting()).toBe(true)

      // Attempting to run should be skipped due to overlap protection
      await handle.run()

      // Wait for handler to settle
      await runPromise
      expect(handlerSettled).toBe(true)
      expect(handle.isExecuting()).toBe(false)
    } finally {
      await app.close()
    }
  })

  it('tracks execution set properly when preventOverlap is false for concurrent runs', async () => {
    let resolveRun1!: () => void
    let resolveRun2!: () => void

    const jobsDecl = defineJobs([
      {
        name: 'concurrent-job',
        schedule: { interval: 60000 },
        preventOverlap: false,
        handler: async ({ name }) => {
          if (name !== 'concurrent-job') throw new Error('invalid name')
          await new Promise<void>((resolve) => {
            if (!resolveRun1) {
              resolveRun1 = resolve
            } else {
              resolveRun2 = resolve
            }
          })
        },
      },
    ])

    const app = await createApp(
      createDefinition({
        services: {
          jobs: createNodeJobsAssembly(jobsDecl),
        },
      }),
    )

    const handle = app.jobs!.get('concurrent-job')!

    try {
      const run1 = handle.run()
      const run2 = handle.run()

      expect(handle.isExecuting()).toBe(true)

      // Resolve only run1
      resolveRun1()
      await run1

      // run2 is still executing, so isExecuting must remain TRUE!
      expect(handle.isExecuting()).toBe(true)

      // Now resolve run2
      resolveRun2()
      await run2

      // Now all executions have completed, so isExecuting becomes FALSE!
      expect(handle.isExecuting()).toBe(false)
    } finally {
      await app.close()
    }
  })

  it('rejects manual run() on failure but logs and continues scheduler for scheduled runs', async () => {
    let failCount = 0

    const jobsDecl = defineJobs([
      {
        name: 'faulty-job',
        schedule: { interval: 25 },
        handler: () => {
          failCount++
          throw new Error('boom')
        },
      },
    ])

    const app = await createApp(
      createDefinition({
        services: {
          jobs: createNodeJobsAssembly(jobsDecl),
        },
      }),
    )

    const handle = app.jobs!.get('faulty-job')!

    try {
      // Manual run() must reject!
      await expect(handle.run()).rejects.toThrow('boom')
      expect(failCount).toBe(1)

      // Scheduled run happens without crashing process
      await new Promise((r) => setTimeout(r, 60))
      expect(failCount).toBeGreaterThanOrEqual(2)
    } finally {
      await app.close()
    }
  })

  it('drains active tasks gracefully on application close within budget', async () => {
    let finishedCleanly = false

    const jobsDecl = defineJobs([
      {
        name: 'draining-job',
        schedule: { interval: 10000 },
        handler: async () => {
          await new Promise((r) => setTimeout(r, 50))
          finishedCleanly = true
        },
      },
    ])

    const app = await createApp(
      createDefinition({
        services: {
          jobs: createNodeJobsAssembly(jobsDecl),
        },
      }),
    )

    const handle = app.jobs!.get('draining-job')!
    void handle.run()

    // Application close starts while job is active
    await new Promise((r) => setTimeout(r, 10))
    expect(handle.isExecuting()).toBe(true)

    // close() should wait for in-flight job to finish cleanly
    await app.close()
    expect(finishedCleanly).toBe(true)
  })

  it('aborts in-flight tasks when close deadline budget is exceeded', async () => {
    let abortReasonReceived: unknown

    const jobsDecl = defineJobs([
      {
        name: 'hung-job',
        schedule: { interval: 10000 },
        handler: async ({ signal }) => {
          await new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => {
              abortReasonReceived = signal.reason
              resolve()
            })
          })
        },
      },
    ])

    const app = await createApp(
      createDefinition({
        services: {
          jobs: createNodeJobsAssembly(jobsDecl),
        },
      }),
    )

    const handle = app.jobs!.get('hung-job')!
    void handle.run()

    // Give it a brief moment to start
    await new Promise((r) => setTimeout(r, 10))
    expect(handle.isExecuting()).toBe(true)

    // Close with a tight deadline of 30ms on the performance.now clock
    const deadline = performance.now() + 30
    await expect(app.jobs!.close(deadline)).rejects.toThrow()

    expect(abortReasonReceived).toBeDefined()
  })

  it('rejects manual run() immediately once application enters draining', async () => {
    let jobStarted = false
    let resolveJob!: () => void

    const jobsDecl = defineJobs([
      {
        name: 'overlapping-task',
        schedule: { interval: 10000 },
        preventOverlap: false,
        handler: async () => {
          jobStarted = true
          await new Promise<void>((r) => {
            resolveJob = r
          })
        },
      },
    ])

    const app = await createApp(
      createDefinition({
        services: {
          jobs: createNodeJobsAssembly(jobsDecl),
        },
      }),
    )

    const handle = app.jobs!.get('overlapping-task')!
    const inFlight = handle.run()

    // Wait until handler is actively executing
    await new Promise((r) => setTimeout(r, 15))
    expect(jobStarted).toBe(true)

    // Trigger app close (which sets lifecycle to draining)
    const closePromise = app.close()

    // Immediate manual run must be rejected because app is draining
    await expect(handle.run()).rejects.toThrow('draining')

    // Clean up in-flight job and let close finish
    resolveJob()
    await inFlight
    await closePromise
  })

  it('dispatches scheduled jobs on Cloudflare Workers and matches cron pattern', async () => {
    const executedCrons: string[] = []

    const jobDefs = [
      {
        name: 'cf-hourly',
        onCron: '0 * * * *',
        handler: async () => {
          executedCrons.push('hourly')
        },
      },
      {
        name: 'cf-daily',
        onCron: '0 0 * * *',
        handler: async () => {
          executedCrons.push('daily')
        },
      },
    ]

    const app = await createApp(createDefinition())
    const waitUntilPromises: Promise<unknown>[] = []
    const ctx = {
      waitUntil(p: Promise<unknown>) {
        waitUntilPromises.push(p)
      },
      passThroughOnException() {},
    }

    try {
      // Dispatch the actual platform cron using the application job index.
      await dispatchCloudflareJobs(
        resolveJobsDeclaration(defineJobs(jobDefs), {}, 'cloudflare'),
        { cron: '0 * * * *', scheduledTime: Date.now(), noRetry() {} },
        {},
        ctx,
        app,
      )

      expect(executedCrons).toEqual(['hourly'])
      expect(waitUntilPromises.length).toBe(1)

      // Unknown cron throws error
      await expect(
        dispatchCloudflareJobs(
          resolveJobsDeclaration(defineJobs(jobDefs), {}, 'cloudflare'),
          { cron: 'unknown', scheduledTime: Date.now(), noRetry() {} },
          {},
          ctx,
          app,
        ),
      ).rejects.toThrow('No scheduled job matched cron')
    } finally {
      await app.close()
    }
  })

  it('dispatches multiple scheduled jobs registered for the same cron pattern', async () => {
    const executed: string[] = []

    const jobDefs = [
      {
        name: 'task-a',
        onCron: '0 0 * * *',
        handler: async () => {
          executed.push('A')
        },
      },
      {
        name: 'task-b',
        onCron: '0 0 * * *',
        handler: async () => {
          executed.push('B')
        },
      },
    ]

    const app = await createApp(createDefinition())
    const ctx = {
      waitUntil(_p: Promise<unknown>) {},
      passThroughOnException() {},
    }

    try {
      await dispatchCloudflareJobs(
        resolveJobsDeclaration(defineJobs(jobDefs), {}, 'cloudflare'),
        { cron: '0 0 * * *', scheduledTime: Date.now(), noRetry() {} },
        {},
        ctx,
        app,
      )
      expect(executed).toEqual(['A', 'B'])
    } finally {
      await app.close()
    }
  })

  it('propagates failure when a scheduled job handler throws', async () => {
    const jobDefs = [
      {
        name: 'faulty-cron',
        onCron: '0 * * * *',
        handler: async () => {
          throw new Error('cron failed')
        },
      },
    ]

    const app = await createApp(createDefinition())
    let waitUntilPromise: Promise<unknown> | undefined
    const ctx = {
      waitUntil(p: Promise<unknown>) {
        waitUntilPromise = p
      },
      passThroughOnException() {},
    }

    try {
      await expect(
        dispatchCloudflareJobs(
          resolveJobsDeclaration(defineJobs(jobDefs), {}, 'cloudflare'),
          { cron: '0 * * * *', scheduledTime: Date.now(), noRetry() {} },
          {},
          ctx,
          app,
        ),
      ).rejects.toThrow('cron failed')

      // waitUntil promise must also reflect the error
      expect(waitUntilPromise).toBeDefined()
      await expect(waitUntilPromise!).rejects.toThrow('cron failed')
    } finally {
      await app.close()
    }
  })

  it('dispatches scheduled events through createWorkerHandler with event resources and cleans them up', async () => {
    let resourceCreated = 0
    let resourceDisposed = 0
    let handlerReceivedDb: unknown

    const eventResource = {
      target: 'cloudflare' as const,
      async createForEvent() {
        resourceCreated++
        return {
          value: { client: 'event-db-client' },
          dispose: async () => {
            resourceDisposed++
          },
        }
      },
    }

    const jobsDecl = defineJobs([
      {
        name: 'cf-resource-job',
        onCron: '0 * * * *',
        handler: async (ctx) => {
          handlerReceivedDb = (ctx as any).db
        },
      },
    ])

    const definition = createDefinition({
      scheduled: createCloudflareJobsHandler(jobsDecl),
      resources: {
        db: eventResource as any,
      },
    })

    const handler = createWorkerHandler(definition)
    const ctx = {
      waitUntil(_p: Promise<unknown>) {},
      passThroughOnException() {},
    }

    await handler.scheduled!(
      { cron: '0 * * * *', scheduledTime: Date.now(), noRetry() {} },
      {},
      ctx,
    )

    expect(resourceCreated).toBe(1)
    expect(handlerReceivedDb).toEqual({ client: 'event-db-client' })
    expect(resourceDisposed).toBe(1)
  })

  it('rejects manual run() immediately once application enters draining', async () => {
    let releaseJob!: () => void

    const jobsDecl = defineJobs([
      {
        name: 'draining-test-job',
        schedule: { interval: 1000 },
        handler: async () => {
          await new Promise<void>((resolve) => {
            releaseJob = resolve
          })
        },
      },
    ])

    const app = await createApp(
      createDefinition({
        services: {
          jobs: createNodeJobsAssembly(jobsDecl),
        },
      }),
    )

    const handle = app.jobs?.get('draining-test-job')
    expect(handle).toBeDefined()

    // Start execution
    const activeRun = handle!.run()
    expect(handle!.isExecuting()).toBe(true)

    // Call app.close() transitioning to draining state
    const closePromise = app.close()

    // Attempting to run while draining must reject
    await expect(handle!.run()).rejects.toThrow(
      'Job "draining-test-job" cannot run: application is draining.',
    )

    // Release job to settle shutdown
    releaseJob()
    await activeRun
    await closePromise
  })

  it('adopts host monotonic performance.now() budget during graceful stop', async () => {
    let abortedWithReason: unknown

    const jobsDecl = defineJobs([
      {
        name: 'budget-test-job',
        schedule: { interval: 1000 },
        handler: async (ctx) => {
          ctx.signal.addEventListener('abort', () => {
            abortedWithReason = ctx.signal.reason
          })
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 300)
          })
        },
      },
    ])

    const app = await createApp(
      createDefinition({
        services: {
          jobs: createNodeJobsAssembly(jobsDecl),
        },
      }),
    )

    const handle = app.jobs?.get('budget-test-job')
    void handle!.run()

    // Close manager with short monotonic deadline (40ms)
    const deadline = performance.now() + 40
    await expect(app.jobs!.close(deadline)).rejects.toThrow('close timed out')
    expect(abortedWithReason).toBeDefined()

    await app.close()
  })
})

it('releases already prepared paused Croner instances when a later schedule fails', async () => {
  const { Cron } = await import('croner')
  const { vi } = await import('vitest')
  const stopped = vi.spyOn(Cron.prototype, 'stop')
  const handler = vi.fn()
  const jobs = defineJobs([
    { name: 'prepared', schedule: '* * * * *', runOnInit: true, handler },
    { name: 'invalid', schedule: 'invalid cron expression', handler },
  ])
  try {
    await expect(
      createApp(createDefinition({ services: { jobs: createNodeJobsAssembly(jobs) } })),
    ).rejects.toThrow()
    expect(stopped).toHaveBeenCalledOnce()
    expect(handler).not.toHaveBeenCalled()
  } finally {
    stopped.mockRestore()
  }
})
