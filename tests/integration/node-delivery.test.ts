import { once } from 'node:events'

import { describe, expect, it } from 'vitest'

import { createDefinition } from '../../src/entries/runtime/core'
import { startNodeServer } from '../../src/entries/runtime/node'
import { createApp, defineApp, route } from '../../src/entries/server'
import { defineNodeRuntime } from '../../src/entries/server/node'
import { routeEntry as entry } from '../helpers/http-app'

describe('node delivery', () => {
  it('Node delivery-layer compression compresses responses when gzip requested', async () => {
    const e = entry('/api/large', () => ({ data: 'a'.repeat(2000) }))
    const app = await createApp(createDefinition({ app: defineApp(), routes: [e] }))
    const server = await startNodeServer(app, defineNodeRuntime({ port: 0 }))
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/large`, {
        headers: { 'Accept-Encoding': 'gzip' },
      })
      expect(res.status).toBe(200)
      expect(res.headers.get('content-encoding')).toBe('gzip')
    } finally {
      await server.close()
    }
  })

  it('default Node probe endpoints are reachable', async () => {
    const app = await createApp(createDefinition({ app: defineApp({ csrf: false }) }))
    const server = await startNodeServer(app, defineNodeRuntime({ port: 0 }))
    try {
      const live = await fetch(`http://127.0.0.1:${server.port}/livez`)
      const ready = await fetch(`http://127.0.0.1:${server.port}/readyz`)
      expect([live.status, ready.status]).toEqual([200, 200])
    } finally {
      await server.close()
      await app.close()
    }
  })

  it('custom compression filter still excludes event streams', async () => {
    const e = entry(
      'events.get.ts',
      route().handler(
        () =>
          new Response('data: hello\n\n', {
            headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'private' },
          }),
      ),
    )
    const app = await createApp(createDefinition({ app: defineApp({ csrf: false }), routes: [e] }))
    const server = await startNodeServer(
      app,
      defineNodeRuntime({ port: 0, compress: { threshold: 0, contentTypeFilter: () => true } }),
    )
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/events`, {
        headers: { 'Accept-Encoding': 'gzip' },
      })
      expect(res.headers.get('Content-Encoding')).toBeNull()
      expect(res.headers.get('Cache-Control')).toContain('private')
    } finally {
      await server.close()
      await app.close()
    }
  })

  it('disables probe endpoints when probes option is false', async () => {
    const app = await createApp(createDefinition({ app: defineApp({ csrf: false }) }))
    const server = await startNodeServer(app, defineNodeRuntime({ port: 0, probes: false }))
    try {
      const live = await fetch(`http://127.0.0.1:${server.port}/livez`)
      const ready = await fetch(`http://127.0.0.1:${server.port}/readyz`)
      expect(live.status).toBe(404)
      expect(ready.status).toBe(404)
    } finally {
      await server.close()
      await app.close()
    }
  })

  it('partially overrides probe endpoints while retaining unconfigured defaults', async () => {
    const app = await createApp(createDefinition({ app: defineApp({ csrf: false }) }))
    const server = await startNodeServer(
      app,
      defineNodeRuntime({ port: 0, probes: { liveness: '/custom/live' } }),
    )
    try {
      const customLive = await fetch(`http://127.0.0.1:${server.port}/custom/live`)
      const defaultReady = await fetch(`http://127.0.0.1:${server.port}/readyz`)
      const oldLive = await fetch(`http://127.0.0.1:${server.port}/livez`)
      expect(customLive.status).toBe(200)
      expect((await customLive.json()).status).toBe('ok')
      expect(defaultReady.status).toBe(200)
      expect((await defaultReady.json()).status).toBe('ok')
      expect(oldLive.status).toBe(404)
    } finally {
      await server.close()
      await app.close()
    }
  })

  it('disables compression when compress option is false', async () => {
    const e = entry('/api/large-raw', () => ({ data: 'x'.repeat(3000) }))
    const app = await createApp(createDefinition({ app: defineApp(), routes: [e] }))
    const server = await startNodeServer(app, defineNodeRuntime({ port: 0, compress: false }))
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/large-raw`, {
        headers: { 'Accept-Encoding': 'gzip' },
      })
      expect(res.status).toBe(200)
      expect(res.headers.get('content-encoding')).toBeNull()
    } finally {
      await server.close()
      await app.close()
    }
  })

  it('overrides compression threshold with explicit threshold option', async () => {
    const e = entry('/api/threshold-test', () => ({ data: 'x'.repeat(2000) }))
    const app = await createApp(createDefinition({ app: defineApp(), routes: [e] }))
    const server = await startNodeServer(
      app,
      defineNodeRuntime({ port: 0, compress: { threshold: 5000 } }),
    )
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/threshold-test`, {
        headers: { 'Accept-Encoding': 'gzip' },
      })
      expect(res.status).toBe(200)
      expect(res.headers.get('content-encoding')).toBeNull()
    } finally {
      await server.close()
      await app.close()
    }
  })

  it('closing Node transport enters draining before accepted work completes', async () => {
    let enteredResolve: any
    let release: any
    const entered = new Promise((resolve) => {
      enteredResolve = resolve
    })
    const gate = new Promise((resolve) => {
      release = resolve
    })

    const e = entry(
      'slow.get.ts',
      route().handler(async () => {
        enteredResolve()
        await gate
        return { ok: true }
      }),
    )
    const app = await createApp(createDefinition({ app: defineApp({ csrf: false }), routes: [e] }))
    const server = await startNodeServer(app, defineNodeRuntime({ port: 0 }))

    const request = fetch(`http://127.0.0.1:${server.port}/api/slow`)
    await entered
    const closing = server.close()
    const stateWhileClosing = app.state
    release()
    await request
    await closing
    await app.close()
    expect(stateWhileClosing).toBe('draining')
  })

  it('Range requests bypass delivery-layer compression', async () => {
    const e = entry('/api/range-data', () => ({ data: 'a'.repeat(2000) }))
    const app = await createApp(createDefinition({ app: defineApp(), routes: [e] }))
    const server = await startNodeServer(app, defineNodeRuntime({ port: 0 }))
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/range-data`, {
        headers: {
          'Accept-Encoding': 'gzip',
          Range: 'bytes=0-100',
        },
      })
      expect(res.status).toBe(200)
      expect(res.headers.get('content-encoding')).toBeNull()
    } finally {
      await server.close()
    }
  })

  it('delivers real Server-Sent Events over TCP and bypasses compression', async () => {
    const e = entry(
      'events.sse.ts',
      route()
        .events<{ live: { count: number } }>({ heartbeat: 40 })
        .handler(() => ({
          async onOpen(stream) {
            await stream.send('live', { count: 1 })
            await new Promise((r) => setTimeout(r, 50))
            await stream.send('live', { count: 2 })
            stream.close()
          },
        })),
    )
    const app = await createApp(createDefinition({ app: defineApp({ csrf: false }), routes: [e] }))
    const server = await startNodeServer(app, defineNodeRuntime({ port: 0 }))
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/events`, {
        headers: { 'Accept-Encoding': 'gzip' },
      })
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/event-stream')
      expect(res.headers.get('content-encoding')).toBeNull()

      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let text = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        text += decoder.decode(value)
      }
      expect(text).toContain('event: live')
      expect(text).toContain('"count":1')
      expect(text).toContain('"count":2')
      expect(text).toContain(': heartbeat')
    } finally {
      await server.close()
      await app.close()
    }
  })

  it('cancels an SSE producer cooperatively before disposing the Node application', async () => {
    const entered = Promise.withResolvers<void>()
    let closedTriggered = false
    const e = entry(
      'drain.sse.ts',
      route()
        .events<{ ready: boolean }>({ heartbeat: false })
        .handler(() => ({
          async onOpen(stream) {
            await stream.send('ready', true)
            entered.resolve()
            if (!stream.signal.aborted) await once(stream.signal, 'abort')
          },
          onClose() {
            closedTriggered = true
          },
        })),
    )
    const app = await createApp(createDefinition({ routes: [e] }))
    const server = await startNodeServer(
      app,
      defineNodeRuntime({ port: 0, shutdown: { deadline: 600, reserve: 100 } }),
    )
    let response: Response | undefined
    try {
      response = await fetch(`http://127.0.0.1:${server.port}/api/drain`)
      await entered.promise
      await server.close()
      expect(closedTriggered).toBe(true)
    } finally {
      await response?.body?.cancel()
      await server.close()
    }
  })
})
