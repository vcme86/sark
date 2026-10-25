import { describe, expect, it, vi } from 'vitest'

import { getCurrentScope } from '../../src/core/context'
import { applicationLifecycles } from '../../src/core/lifecycle'
import { createDefinition } from '../../src/entries/runtime/core'
import { startNodeServer } from '../../src/entries/runtime/node'
import { createApp, dedup, defineApp, route } from '../../src/entries/server'
import { defineNodeRuntime } from '../../src/entries/server/node'
import { parseApiFilePath } from '../../src/web/http/path'
import type { RouteDeclaration } from '../../src/web/http/types'

const entry = (file: string, declaration: RouteDeclaration) => ({
  routePath: parseApiFilePath(file, '/api')!,
  declaration,
})

it('shares concurrent instance close completion and rejects new external business', async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const app = await createApp(
    createDefinition({
      routes: [
        entry(
          'slow.get.ts',
          route().handler(async () => {
            entered.resolve()
            await release.promise
            return { ok: true }
          }),
        ),
        entry(
          'ping.get.ts',
          route().handler(() => 'ok'),
        ),
      ],
    }),
  )
  const accepted = app.fetch(new Request('http://localhost/api/slow'))
  await entered.promise
  const first = app.close(),
    second = app.close()
  try {
    expect(first).toBe(second)
    expect(app.state).toBe('draining')
    const rejected = await app.fetch(new Request('http://localhost/api/ping'))
    expect(rejected.status).toBe(503)
    expect(rejected.headers.get('X-Request-Id')).toBeTruthy()
  } finally {
    release.resolve()
    await accepted
    await Promise.all([first, second])
  }
  expect(app.state).toBe('closed')
})

it('allows accepted work to finish an internal call during draining', async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const app = await createApp(
    createDefinition({
      routes: [
        entry(
          'outer.get.ts',
          route().handler(async (): Promise<unknown> => {
            entered.resolve()
            await release.promise
            const response = await app.fetchInternal(new Request('http://localhost/api/inner'))
            return response.json()
          }),
        ),
        entry(
          'inner.get.ts',
          route().handler(() => ({ ok: true })),
        ),
      ],
    }),
  )
  const request = app.fetch(new Request('http://localhost/api/outer'))
  await entered.promise
  const closing = app.close()
  release.resolve()
  expect(await (await request).json()).toEqual({ ok: true })
  await closing
})

it('keeps draining until reverse resource disposal has finished', async () => {
  const app = await createApp(createDefinition())
  const release = Promise.withResolvers<void>()
  const disposing = Promise.withResolvers<void>()
  const order: string[] = []
  const lifecycle = applicationLifecycles.get(app)!
  lifecycle.register({
    name: 'first',
    dispose() {
      order.push('first')
    },
  })
  lifecycle.register({
    name: 'second',
    async dispose() {
      disposing.resolve()
      await release.promise
      order.push('second')
    },
  })
  const closing = app.close()
  await disposing.promise
  expect(app.state).toBe('draining')
  release.resolve()
  await closing
  expect(order).toEqual(['second', 'first'])
  expect(app.state).toBe('closed')
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
      await expect(server.close()).rejects.toThrow('drain budget')
      expect(performance.now() - start).toBeLessThan(1000)
      expect(scopeSignal?.aborted).toBe(true)
      expect(server.server.listening).toBe(false)
      expect(app.state).toBe('closed')
      await response
    } finally {
      release.resolve()
      await finished.promise
      await expect.poll(() => applicationLifecycles.get(app)!.pendingRequests).toBe(0)
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

it('dedup distinguishes argument lengths and references and resets between requests', async () => {
  let calls = 0
  const load = dedup(async (..._args: unknown[]) => ++calls)
  const object = {},
    array: unknown[] = []
  const app = await createApp(
    createDefinition({
      routes: [
        entry(
          'dedup.get.ts',
          route().handler(() =>
            Promise.all([
              load(),
              load(),
              load(undefined),
              load(object),
              load(object),
              load({}),
              load(array),
              load(array),
              load([]),
            ]),
          ),
        ),
      ],
    }),
  )
  try {
    const first = await (await app.fetch(new Request('http://localhost/api/dedup'))).json()
    expect(first).toEqual([1, 1, 2, 3, 3, 4, 5, 5, 6])
    await app.fetch(new Request('http://localhost/api/dedup'))
    expect(calls).toBe(12)
  } finally {
    await app.close()
  }
})
