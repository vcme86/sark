import { describe, expect, it, vi } from 'vitest'

import { getCurrentScope } from '../../src/app/context'
import type { RouteDeclaration } from '../../src/app/http/types'
import { applicationLifecycles } from '../../src/app/lifecycle'
import { defineJobs } from '../../src/entries/jobs'
import { defineNodeRuntime } from '../../src/entries/node'
import { createApp, defineApp, route } from '../../src/entries/root'
import { createDefinition } from '../../src/entries/runtime/core'
import { startNodeServer } from '../../src/entries/runtime/node'
import { createNodeJobsAssembly } from '../../src/features/jobs/assembly-node'
import { parseApiFilePath } from '../../src/http/path'

const entry = (file: string, declaration: RouteDeclaration) => ({
  routePath: parseApiFilePath(file, '/api')!,
  declaration,
})

describe('Node lifecycle integration', () => {
  it('retains creation-time factory configuration across Node requests and internal dispatch', async () => {
    let factoryCalls = 0
    const app = await createApp(
      createDefinition({
        app: defineApp((env: NodeJS.ProcessEnv) => {
          factoryCalls++
          if (!env.RELEASE) throw new Error('RELEASE is required')
          return { headers: { 'X-Release': env.RELEASE } }
        }),
        routes: [
          entry(
            'ping.get.ts',
            route().handler(() => ({ ok: true })),
          ),
          entry(
            'outer.get.ts',
            route().handler(async (): Promise<Response> =>
              app.fetchInternal(new Request('http://localhost/api/ping')),
            ),
          ),
        ],
      }),
      { env: { RELEASE: 'initial' } },
    )
    const host = await startNodeServer(
      app,
      defineNodeRuntime({ port: 0, hostname: '127.0.0.1', compress: false }),
    )
    try {
      for (const path of ['ping', 'ping', 'outer']) {
        const response = await fetch(`http://127.0.0.1:${host.port}/api/${path}`)
        expect(response.status).toBe(200)
        expect(response.headers.get('X-Release')).toBe('initial')
        expect(await response.json()).toEqual({ ok: true })
      }
      expect(factoryCalls).toBe(1)
    } finally {
      await host.close()
    }
  })

  it('uses the actual Node host shutdown budget for an independent job stop', async () => {
    let aborted = false
    const jobs = defineJobs([
      {
        name: 'manual',
        schedule: { interval: 60000 },
        handler: async ({ signal }) => {
          await new Promise<void>((resolve) =>
            signal.addEventListener(
              'abort',
              () => {
                aborted = true
                resolve()
              },
              { once: true },
            ),
          )
        },
      },
    ])
    const app = await createApp(
      createDefinition({ services: { jobs: createNodeJobsAssembly(jobs) } }),
    )
    const host = await startNodeServer(
      app,
      defineNodeRuntime({ port: 0, shutdown: { deadline: 150, reserve: 50 } }),
    )
    const handle = app.jobs!.get('manual')!
    const execution = handle.run()
    const started = performance.now()
    try {
      await expect(handle.stop()).rejects.toThrow('graceful drain budget')
      expect(aborted).toBe(true)
      expect(performance.now() - started).toBeLessThan(1000)
      await execution
    } finally {
      await host.close()
    }
  })

  it('bounds stop by an active host deadline and retains resources until actual job completion', async () => {
    const release = Promise.withResolvers<void>()
    let disposed = false
    const jobs = defineJobs([
      { name: 'held', schedule: { interval: 60000 }, handler: () => release.promise },
    ])
    const app = await createApp(
      createDefinition({
        services: { jobs: createNodeJobsAssembly(jobs) },
        resources: {
          connection: {
            createStatic: async () => ({
              value: {},
              dispose() {
                disposed = true
              },
            }),
          },
        },
      }),
    )
    const host = await startNodeServer(
      app,
      defineNodeRuntime({ port: 0, shutdown: { deadline: 150, reserve: 50 } }),
    )
    const handle = app.jobs!.get('held')!
    const execution = handle.run()
    const closing = host.close().then(
      () => undefined,
      (error) => error,
    )
    try {
      const started = performance.now()
      await expect(handle.stop()).rejects.toThrow()
      expect(performance.now() - started).toBeLessThan(1000)
      expect(await closing).toBeInstanceOf(Error)
      expect(disposed).toBe(false)
      expect(handle.isExecuting()).toBe(true)
    } finally {
      release.resolve()
      await execution
      await app.close().catch(() => {})
      await closing
    }
    expect(disposed).toBe(true)
  })

  it('does not dispose resources twice when app.close follows host close', async () => {
    const app = await createApp(createDefinition())
    const dispose = vi.fn()
    applicationLifecycles.get(app)!.register({ name: 'resource', dispose })
    const host = await startNodeServer(app, defineNodeRuntime({ port: 0 }))
    await host.close()
    await Promise.all([app.close(), app.close()])
    expect(dispose).toHaveBeenCalledOnce()
    expect(app.state).toBe('closed')
  })

  it('bounds resource disposal by the remaining deadline without declaring it completed', async () => {
    const release = Promise.withResolvers<void>()
    const disposing = Promise.withResolvers<void>()
    const app = await createApp(createDefinition())
    applicationLifecycles.get(app)!.register({
      name: 'slow resource',
      async dispose() {
        disposing.resolve()
        await release.promise
      },
    })
    const server = await startNodeServer(
      app,
      defineNodeRuntime({ port: 0, shutdown: { deadline: 150, reserve: 50 } }),
    )
    const closing = server.close()
    await disposing.promise
    try {
      await expect(closing).rejects.toThrow('resource disposal exceeded')
      expect(app.state).toBe('draining')
    } finally {
      release.resolve()
      await app.close()
    }
    expect(app.state).toBe('closed')
  })

  it('serves probes with common scope and headers, without business authorization', async () => {
    const app = await createApp(
      createDefinition({
        app: defineApp({
          middleware: [async (ctx) => ctx.text('denied', 403)],
        }),
      }),
    )
    const server = await startNodeServer(app, defineNodeRuntime({ port: 0 }))
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/readyz`)
      expect(response.status).toBe(200)
      expect(response.headers.get('X-Request-Id')).toBeTruthy()
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
    } finally {
      await server.close()
    }
  })

  it('cancels and terminates an unfinished request within the total shutdown budget', async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const finished = Promise.withResolvers<void>()
    let scopeSignal: AbortSignal | undefined
    const app = await createApp(
      createDefinition({
        routes: [
          entry(
            'slow.get.ts',
            route().handler(async () => {
              scopeSignal = getCurrentScope()?.signal
              entered.resolve()
              try {
                await release.promise
                return 'done'
              } finally {
                finished.resolve()
              }
            }),
          ),
        ],
      }),
    )
    const server = await startNodeServer(
      app,
      defineNodeRuntime({ port: 0, shutdown: { deadline: 150, reserve: 50 } }),
    )
    const response = fetch(`http://127.0.0.1:${server.port}/api/slow`)
      .then((r) => r.text())
      .catch(() => undefined)
    await entered.promise
    const start = performance.now()
    try {
      await expect(server.close()).rejects.toThrow(/drain budget|Application shutdown failed/)
      expect(performance.now() - start).toBeLessThan(1000)
      expect(scopeSignal?.aborted).toBe(true)
      expect(server.server.listening).toBe(false)
      expect(app.state).toBe('draining')
      await response
    } finally {
      release.resolve()
      await finished.promise
      await expect.poll(() => applicationLifecycles.get(app)!.pendingRequests).toBe(0)
      await app.close().catch(() => {})
      expect(app.state).toBe('closed')
    }
  })

  it('waits for streamed delivery when host and instance close concurrently', async () => {
    const release = Promise.withResolvers<void>()
    const app = await createApp(
      createDefinition({
        routes: [
          entry(
            'stream.get.ts',
            route().handler(() => {
              const stream = new ReadableStream<Uint8Array>({
                async start(controller) {
                  controller.enqueue(new TextEncoder().encode('start'))
                  await release.promise
                  controller.close()
                },
              })
              return new Response(stream, { headers: { 'Content-Type': 'text/plain' } })
            }),
          ),
        ],
      }),
    )
    const dispose = vi.fn()
    applicationLifecycles.get(app)!.register({ name: 'resource', dispose })
    const server = await startNodeServer(app, defineNodeRuntime({ port: 0, compress: false }))
    const response = await fetch(`http://127.0.0.1:${server.port}/api/stream`)
    const closing = server.close()
    const instanceClosing = app.close()
    let releasedBeforeDelivery: number
    try {
      await new Promise<void>((resolve) => setImmediate(resolve))
      releasedBeforeDelivery = dispose.mock.calls.length
    } finally {
      release.resolve()
      expect(await response.text()).toBe('start')
      await Promise.all([closing, instanceClosing])
    }
    expect(releasedBeforeDelivery).toBe(0)
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('releases the application when listening fails', async () => {
    const firstApp = await createApp(createDefinition())
    const first = await startNodeServer(firstApp, defineNodeRuntime({ port: 0 }))
    const app = await createApp(createDefinition())
    const dispose = vi.fn()
    applicationLifecycles.get(app)!.register({ name: 'resource', dispose })
    try {
      await expect(
        startNodeServer(app, defineNodeRuntime({ port: first.port })),
      ).rejects.toMatchObject({ code: 'EADDRINUSE' })
      expect(dispose).toHaveBeenCalledOnce()
      expect(app.state).toBe('closed')
    } finally {
      await first.close()
    }
  })
})
