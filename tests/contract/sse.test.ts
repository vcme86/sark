import { describe, expect, it, vi } from 'vitest'

import { createWorkerHandler } from '../../src/adapter/cloudflare/runtime'
import { getCurrentScope, getRequestId } from '../../src/app/context'
import type { RouteEntry } from '../../src/app/http/assembly'
import type { RouteDeclaration, SseDeclaration, SseStream } from '../../src/app/http/types'
import { applicationLifecycles } from '../../src/app/lifecycle'
import type { ServiceAssembly } from '../../src/app/service'
import { createClient } from '../../src/entries/client'
import { createApp, defineApp, HttpError, route, z } from '../../src/entries/root'
import { createDefinition } from '../../src/entries/runtime/core'
import { parseApiFilePath } from '../../src/http/path'

function entry(
  source: string,
  declaration: RouteDeclaration | SseDeclaration,
  prefix = '/api',
): RouteEntry {
  return { source, routePath: parseApiFilePath(source, prefix)!, declaration }
}

describe('Server-Sent Events (SSE)', () => {
  it('streams typed events to client with JSON payloads', async () => {
    let openCalled = false
    let closeCalled = false

    const declaration = route()
      .events<{ message: { text: string }; update: { count: number } }>({ heartbeat: false })
      .handler(() => ({
        async onOpen(stream) {
          openCalled = true
          await stream.send('message', { text: 'hello' })
          await stream.send('update', { count: 42 })
        },
        onClose() {
          closeCalled = true
        },
      }))

    const app = await createApp(
      createDefinition({
        routes: [entry('events.sse.ts', declaration)],
      }),
    )

    type TestApi = {
      '/events': {
        SSE: {
          input: {}
          output: Response
          events: {
            message: { text: string }
            update: { count: number }
          }
        }
      }
    }

    const client = createClient<TestApi>({
      baseUrl: 'https://example.test/api',
      fetch: (req) => app.fetch(req),
    })

    const receivedMessages: Array<{ text: string }> = []
    const receivedUpdates: Array<{ count: number }> = []

    const done = Promise.withResolvers<void>()

    const conn = client.sse('/events')
    conn.on('message', (msg) => {
      receivedMessages.push(msg)
    })
    conn.on('update', (upd) => {
      receivedUpdates.push(upd)
      if (receivedUpdates.length === 1) {
        conn.close()
        done.resolve()
      }
    })

    await done.promise

    expect(openCalled).toBe(true)
    expect(receivedMessages).toEqual([{ text: 'hello' }])
    expect(receivedUpdates).toEqual([{ count: 42 }])
    await new Promise((r) => setTimeout(r, 20))
    expect(closeCalled).toBe(true)
  })

  it('HEAD request validates input and admission without starting the stream or heartbeat', async () => {
    let producerStarted = false

    const declaration = route()
      .validate({ query: z.object({ token: z.string() }) })
      .events<{ tick: { time: number } }>({ heartbeat: 100 })
      .handler((_ctx, input) => {
        if (input.query.token !== 'valid-token') {
          throw new HttpError(401, 'Unauthorized')
        }
        return {
          onOpen() {
            producerStarted = true
          },
        }
      })

    const app = await createApp(
      createDefinition({
        routes: [entry('clock.sse.ts', declaration)],
      }),
    )

    // 1. Invalid input on HEAD -> 400
    const invalidHead = await app.fetch(
      new Request('https://example.test/api/clock', { method: 'HEAD' }),
    )
    expect(invalidHead.status).toBe(400)
    expect(producerStarted).toBe(false)

    // 2. Unauthorized on HEAD -> 401
    const unauthHead = await app.fetch(
      new Request('https://example.test/api/clock?token=bad', { method: 'HEAD' }),
    )
    expect(unauthHead.status).toBe(401)
    expect(producerStarted).toBe(false)

    // 3. Valid HEAD -> 200 without starting producer
    const validHead = await app.fetch(
      new Request('https://example.test/api/clock?token=valid-token', { method: 'HEAD' }),
    )
    expect(validHead.status).toBe(200)
    expect(validHead.headers.get('content-type')).toContain('text/event-stream')
    expect(validHead.headers.get('cache-control')).toBe('no-cache')
    expect(await validHead.text()).toBe('')
    expect(producerStarted).toBe(false)
  })

  it('emits comment frames for heartbeat without dispatching them as user events', async () => {
    const declaration = route()
      .events<{ tick: { num: number } }>({ heartbeat: 20 })
      .handler(() => ({
        onOpen() {},
      }))

    const app = await createApp(
      createDefinition({
        routes: [entry('heartbeat.sse.ts', declaration)],
      }),
    )

    const response = await app.fetch(new Request('https://example.test/api/heartbeat'))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')

    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let chunks = ''

    // Read until we see a heartbeat comment frame
    while (!chunks.includes(': heartbeat')) {
      const { value, done } = await reader.read()
      if (done) break
      chunks += decoder.decode(value)
    }

    expect(chunks).toContain(': heartbeat\n\n')
    await reader.cancel()
  })

  it('rejects connection on admission failure and reports HttpError through onError', async () => {
    const declaration = route()
      .events<{ test: string }>()
      .handler(() => {
        throw new HttpError(403, 'Access denied', { code: 'forbidden_stream' })
      })

    const app = await createApp(
      createDefinition({
        routes: [entry('secure.sse.ts', declaration)],
      }),
    )

    interface SecureApi {
      '/secure': {
        SSE: {
          input: {}
          output: Response
          events: {
            test: string
          }
        }
      }
    }

    const client = createClient<SecureApi>({
      baseUrl: 'https://example.test/api',
      fetch: (req) => app.fetch(req),
    })

    const errorPromise = Promise.withResolvers<any>()
    const conn = client.sse('/secure')
    conn.onError((err) => {
      errorPromise.resolve(err)
      conn.close()
    })

    const reportedError = await errorPromise.promise
    expect(reportedError).toBeInstanceOf(HttpError)
    expect(reportedError.status).toBe(403)
    expect(reportedError.body?.error?.code).toBe('forbidden_stream')
  })

  it('separates event named "error" from connection error channel', async () => {
    const declaration = route()
      .events<{ error: { reason: string }; data: string }>({ heartbeat: false })
      .handler(() => ({
        async onOpen(stream) {
          // Send an event named "error"
          await stream.send('error', { reason: 'business_validation_failed' })
        },
      }))

    const app = await createApp(
      createDefinition({
        routes: [entry('err-channel.sse.ts', declaration)],
      }),
    )

    interface ErrChannelApi {
      '/err-channel': {
        SSE: {
          input: {}
          output: Response
          events: {
            error: { reason: string }
            data: string
          }
        }
      }
    }

    const client = createClient<ErrChannelApi>({
      baseUrl: 'https://example.test/api',
      fetch: (req) => app.fetch(req),
    })

    let connectionErrorCalled = false
    const businessErrorReceived = Promise.withResolvers<any>()

    const conn = client.sse('/err-channel')
    conn.onError(() => {
      connectionErrorCalled = true
    })
    conn.on('error', (payload) => {
      businessErrorReceived.resolve(payload)
      conn.close()
    })

    const payload = await businessErrorReceived.promise
    expect(payload).toEqual({ reason: 'business_validation_failed' })
    expect(connectionErrorCalled).toBe(false)
  })

  it('reconnects with Last-Event-ID and updated retry interval', async () => {
    let connectCount = 0
    let lastSeenIdHeader: string | null = null

    const declaration = route()
      .events<{ item: string }>({ heartbeat: false })
      .handler((ctx) => {
        connectCount++
        lastSeenIdHeader = ctx.req.header('last-event-id') ?? null
        const currentCount = connectCount
        return {
          async onOpen(stream) {
            if (currentCount === 1) {
              await stream.send('item', 'first', { id: 'evt-100', retry: 30 })
              // Close server stream to force client reconnect
              stream.close()
            } else {
              await stream.send('item', 'second', { id: 'evt-101' })
            }
          },
        }
      })

    const app = await createApp(
      createDefinition({
        routes: [entry('reconnect.sse.ts', declaration)],
      }),
    )

    type ReconnectApi = {
      '/reconnect': {
        SSE: {
          input: {}
          output: Response
          events: {
            item: string
          }
        }
      }
    }

    const client = createClient<ReconnectApi>({
      baseUrl: 'https://example.test/api',
      fetch: (req) => app.fetch(req),
    })

    const items: string[] = []
    const done = Promise.withResolvers<void>()

    const conn = client.sse('/reconnect')
    conn.on('item', (val) => {
      items.push(val)
      if (items.length === 2) {
        conn.close()
        done.resolve()
      }
    })

    await done.promise

    expect(items).toEqual(['first', 'second'])
    expect(connectCount).toBe(2)
    expect(lastSeenIdHeader).toBe('evt-100')
  })

  it('stops reconnection on HTTP 204', async () => {
    let connectCount = 0

    const declaration = route()
      .events<{ test: string }>()
      .handler(() => {
        connectCount++
        return new Response(null, { status: 204 })
      })

    const app = await createApp(
      createDefinition({
        routes: [entry('stop204.sse.ts', declaration)],
      }),
    )

    interface Stop204Api {
      '/stop204': {
        SSE: {
          input: {}
          output: Response
          events: {
            test: string
          }
        }
      }
    }

    const client = createClient<Stop204Api>({
      baseUrl: 'https://example.test/api',
      fetch: (req) => app.fetch(req),
    })

    const conn = client.sse('/stop204')
    await new Promise((r) => setTimeout(r, 80))
    conn.close()

    expect(connectCount).toBe(1)
  })

  it('rejects route conflicts between .sse.ts and .get.ts on the same path', async () => {
    const sseRoute = entry(
      'status.sse.ts',
      route()
        .events<{ ok: boolean }>()
        .handler(() => ({})),
    )
    const getRoute = entry(
      'status.get.ts',
      route().handler(() => ({ ok: true })),
    )

    await expect(
      createApp(
        createDefinition({
          routes: [sseRoute, getRoute],
        }),
      ),
    ).rejects.toThrow(/Route conflict.*status/i)
  })

  it('rejects body schemas declared on SSE routes', () => {
    expect(() => {
      route()
        .validate({ json: z.object({ bad: z.string() }) } as any)
        .events()
    }).toThrow('SSE routes cannot declare a request body schema.')
  })

  it('respects backpressure on send and tracks stream in lifecycle', async () => {
    let streamRef: any
    let closedTriggered = false

    const declaration = route()
      .events<{ chunk: { seq: number } }>({ heartbeat: false })
      .handler(() => ({
        onOpen(stream) {
          streamRef = stream
        },
        onClose() {
          closedTriggered = true
        },
      }))

    const app = await createApp(
      createDefinition({
        routes: [entry('backpressure.sse.ts', declaration)],
      }),
    )

    const res = await app.fetch(new Request('https://example.test/api/backpressure'))
    const reader = res.body!.getReader()

    // Sending is sequential and awaits write completion
    await streamRef.send('chunk', { seq: 1 })
    const { value: chunk1 } = await reader.read()
    expect(new TextDecoder().decode(chunk1)).toContain('event: chunk\ndata: {"seq":1}\n\n')

    await streamRef.close()
    const { done } = await reader.read()
    expect(done).toBe(true)
    expect(closedTriggered).toBe(true)
    await app.close()
  })

  it('preserves JSON string and boolean types without coercion', async () => {
    const declaration = route()
      .events<{
        types: {
          strNum: string
          strBool: string
          realNum: number
          realBool: boolean
        }
      }>({ heartbeat: false })
      .handler(() => ({
        async onOpen(stream) {
          await stream.send('types', {
            strNum: '123',
            strBool: 'true',
            realNum: 123,
            realBool: true,
          })
        },
      }))

    const app = await createApp(
      createDefinition({
        routes: [entry('types.sse.ts', declaration)],
      }),
    )

    type TypesApi = {
      '/types': {
        SSE: {
          input: {}
          output: Response
          events: {
            types: {
              strNum: string
              strBool: string
              realNum: number
              realBool: boolean
            }
          }
        }
      }
    }

    const client = createClient<TypesApi>({
      baseUrl: 'https://example.test/api',
      fetch: (req) => app.fetch(req),
    })

    const payloadPromise = Promise.withResolvers<any>()
    const conn = client.sse('/types')
    conn.on('types', (data) => {
      payloadPromise.resolve(data)
      conn.close()
    })

    const received = await payloadPromise.promise
    expect(typeof received.strNum).toBe('string')
    expect(received.strNum).toBe('123')
    expect(typeof received.strBool).toBe('string')
    expect(received.strBool).toBe('true')
    expect(typeof received.realNum).toBe('number')
    expect(received.realNum).toBe(123)
    expect(typeof received.realBool).toBe('boolean')
    expect(received.realBool).toBe(true)
    await app.close()
  })

  it('handles CRLF split across chunk boundaries without resetting event name to message', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: item\r'))
        controller.enqueue(new TextEncoder().encode('\ndata: "hello"\r\n\r\n'))
        controller.close()
      },
    })

    type SplitApi = {
      '/split': {
        SSE: {
          input: {}
          output: Response
          events: {
            item: string
            message: string
          }
        }
      }
    }

    const client = createClient<SplitApi>({
      baseUrl: 'https://example.test/api',
      fetch: async () =>
        new Response(stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
    })

    let messageDispatched = false
    const itemPromise = Promise.withResolvers<string>()

    const conn = client.sse('/split')
    conn.on('item', (val) => {
      itemPromise.resolve(val)
      conn.close()
    })
    conn.on('message', () => {
      messageDispatched = true
    })

    const itemVal = await itemPromise.promise
    expect(itemVal).toBe('hello')
    expect(messageDispatched).toBe(false)
  })

  it('rejects non-text/event-stream responses and halts reconnection', async () => {
    type HtmlApi = {
      '/html': {
        SSE: {
          input: {}
          output: Response
          events: {
            item: string
          }
        }
      }
    }

    let fetchCount = 0
    const client = createClient<HtmlApi>({
      baseUrl: 'https://example.test/api',
      fetch: async () => {
        fetchCount++
        return new Response('<html><body>Login Page</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        })
      },
    })

    const errorPromise = Promise.withResolvers<any>()
    const conn = client.sse('/html')
    conn.onError((err) => {
      errorPromise.resolve(err)
    })

    const err = await errorPromise.promise
    expect(err).toBeInstanceOf(HttpError)
    expect(err.code).toBe('invalid_content_type')
    // Wait briefly to confirm no reconnection attempts are scheduled
    await new Promise((r) => setTimeout(r, 50))
    expect(fetchCount).toBe(1)
    conn.close()
  })

  it('restores request scope in onClose and app.close waits for async onClose work', async () => {
    let capturedReqIdOpen: string | undefined
    let capturedReqIdClose: string | undefined
    let asyncWorkFinished = false

    const declaration = route()
      .events<{ test: string }>({ heartbeat: false })
      .handler(() => ({
        onOpen() {
          capturedReqIdOpen = getRequestId()
        },
        async onClose() {
          capturedReqIdClose = getRequestId()
          await new Promise((r) => setTimeout(r, 40))
          asyncWorkFinished = true
        },
      }))

    const app = await createApp(
      createDefinition({
        routes: [entry('scope-drain.sse.ts', declaration)],
      }),
    )

    const res = await app.fetch(new Request('https://example.test/api/scope-drain'))
    expect(res.status).toBe(200)
    expect(typeof capturedReqIdOpen).toBe('string')
    expect(capturedReqIdOpen!.length).toBeGreaterThan(0)

    // Trigger close on app while connection is active
    const closePromise = app.close()
    await closePromise

    expect(capturedReqIdClose).toBe(capturedReqIdOpen)
    expect(asyncWorkFinished).toBe(true)
  })

  it('draining signal terminates idle SSE connection', async () => {
    let streamClosed = false

    const declaration = route()
      .events<{ idle: string }>({ heartbeat: false })
      .handler(() => ({
        onClose() {
          streamClosed = true
        },
      }))

    const app = await createApp(
      createDefinition({
        routes: [entry('draining.sse.ts', declaration)],
      }),
    )

    const res = await app.fetch(new Request('https://example.test/api/draining'))
    const reader = res.body!.getReader()

    // App shutdown sets draining, which should abort drainingSignal and close the stream
    await app.close()

    const { done } = await reader.read()
    expect(done).toBe(true)
    expect(streamClosed).toBe(true)
  })

  it('ignores events without data fields without raising errors per WHATWG spec', async () => {
    const errorSpy = vi.fn()
    const messageSpy = vi.fn()

    const rawStream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: ping\r\n\r\n'))
        controller.enqueue(new TextEncoder().encode('event: valid\r\ndata: {"ok":true}\r\n\r\n'))
        controller.close()
      },
    })

    const customFetch = vi.fn().mockResolvedValue(
      new Response(rawStream, {
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    )

    const client = createClient<{
      '/test': {
        SSE: {
          input: {}
          output: Response
          events: { valid: { ok: boolean }; ping: unknown }
        }
      }
    }>({
      baseUrl: 'https://example.test',
      fetch: customFetch,
    })

    const conn = client.sse('/test')
    conn.onError(errorSpy)
    conn.on('valid', messageSpy)

    await new Promise((resolve) => setTimeout(resolve, 50))
    conn.close()

    expect(errorSpy).not.toHaveBeenCalled()
    expect(messageSpy).toHaveBeenCalledWith({ ok: true })
  })

  it('synchronizes connectionScope.signal with stream.signal and tracks async onOpen', async () => {
    let signalMatches = false
    let openWorkFinished = false

    const declaration = route()
      .events<{ ping: string }>({ heartbeat: false })
      .handler(() => ({
        async onOpen(stream) {
          const scope = getCurrentScope()
          signalMatches = scope?.signal === stream.signal
          await new Promise((r) => setTimeout(r, 60))
          openWorkFinished = true
        },
      }))

    const app = await createApp(
      createDefinition({
        routes: [entry('scope-sync.sse.ts', declaration)],
      }),
    )

    const res = await app.fetch(new Request('https://example.test/api/scope-sync'))
    const reader = res.body!.getReader()

    await new Promise((r) => setTimeout(r, 20))
    expect(signalMatches).toBe(true)

    await reader.cancel()
    await app.close()

    expect(openWorkFinished).toBe(true)
  })

  it('allows stream.close() inside onOpen without causing self-deadlock', async () => {
    let closeCompleted = false
    const declaration = route()
      .events<{ tick: number }>({ heartbeat: false })
      .handler(() => ({
        async onOpen(stream) {
          await stream.send('tick', 1)
          await stream.close()
        },
        onClose() {
          closeCompleted = true
        },
      }))

    const app = await createApp(
      createDefinition({
        routes: [entry('self-close.sse.ts', declaration)],
      }),
    )

    const res = await app.fetch(new Request('https://example.test/api/self-close'))
    const reader = res.body!.getReader()
    const { value: chunk } = await reader.read()
    expect(new TextDecoder().decode(chunk)).toContain('event: tick\ndata: 1\n\n')
    const { done } = await reader.read()
    expect(done).toBe(true)
    expect(closeCompleted).toBe(true)
    await app.close()
  })

  it('applies backpressure on rapid send calls when downstream reader is paused', async () => {
    let writtenCount = 0
    let openFinished = false
    const declaration = route()
      .events<{ item: number }>({ heartbeat: false })
      .handler(() => ({
        async onOpen(stream) {
          for (let i = 0; i < 20; i++) {
            await stream.send('item', i)
            writtenCount++
          }
          openFinished = true
          stream.close()
        },
      }))

    const app = await createApp(
      createDefinition({
        routes: [entry('backpressure-drain.sse.ts', declaration)],
      }),
    )

    const res = await app.fetch(new Request('https://example.test/api/backpressure-drain'))
    // Downstream reader has not read yet; buffer should fill and send pause
    await new Promise((r) => setTimeout(r, 60))
    expect(openFinished).toBe(false)
    expect(writtenCount).toBeLessThan(10)

    // Now downstream reads, releasing backpressure
    const reader = res.body!.getReader()
    for (let i = 0; i < 20; i++) {
      const chunk = await reader.read()
      if (chunk.done) break
    }
    await new Promise((r) => setTimeout(r, 20))
    expect(openFinished).toBe(true)
    expect(writtenCount).toBe(20)
    await reader.cancel()
    await app.close()
  })

  it('rejects CR and LF in event name and id per WHATWG specification', async () => {
    const declaration = route()
      .events<Record<string, any>>({ heartbeat: false })
      .handler(() => ({
        async onOpen(stream) {
          await expect((stream as any).send('event\nwith\nnewline', 'data')).rejects.toThrow(
            /CR or LF/,
          )
          await expect(
            (stream as any).send('event', 'data', { id: 'id\rwith\rcr' }),
          ).rejects.toThrow(/CR or LF/)
        },
      }))

    const app = await createApp(
      createDefinition({
        routes: [entry('crlf-check.sse.ts', declaration)],
      }),
    )

    const res = await app.fetch(new Request('https://example.test/api/crlf-check'))
    const reader = res.body!.getReader()
    await reader.cancel()
    await app.close()
  })

  it('handles JSON serialization failure in send rejecting promise and reporting to onError on unhandled throw', async () => {
    let sendError: unknown
    let caughtErrorReported: unknown
    let unhandledErrorReported: unknown
    const circular: any = {}
    circular.self = circular

    // 1. Caught in onOpen -> send rejects promise, onError not called
    const caughtDeclaration = route()
      .events<{ bad: any }>({ heartbeat: false })
      .handler(() => ({
        async onOpen(stream) {
          try {
            await stream.send('bad', circular)
          } catch (err) {
            sendError = err
          }
        },
        onError(_stream, err) {
          caughtErrorReported = err
        },
      }))

    const caughtApp = await createApp(
      createDefinition({
        routes: [entry('caught-bad-json.sse.ts', caughtDeclaration)],
      }),
    )

    const caughtRes = await caughtApp.fetch(new Request('https://example.test/api/caught-bad-json'))
    const caughtReader = caughtRes.body!.getReader()
    await new Promise((r) => setTimeout(r, 50))
    expect(sendError).toBeInstanceOf(Error)
    expect(caughtErrorReported).toBeUndefined()
    await caughtReader.cancel()
    await caughtApp.close()

    // 2. Unhandled in onOpen -> reports to onError
    const unhandledDeclaration = route()
      .events<{ bad: any }>({ heartbeat: false })
      .handler(() => ({
        async onOpen(stream) {
          await stream.send('bad', circular)
        },
        onError(_stream, err) {
          unhandledErrorReported = err
        },
      }))

    const unhandledApp = await createApp(
      createDefinition({
        routes: [entry('unhandled-bad-json.sse.ts', unhandledDeclaration)],
      }),
    )

    const unhandledRes = await unhandledApp.fetch(
      new Request('https://example.test/api/unhandled-bad-json'),
    )
    const unhandledReader = unhandledRes.body!.getReader()
    await new Promise((r) => setTimeout(r, 50))
    expect(unhandledErrorReported).toBeInstanceOf(Error)
    await unhandledReader.cancel()
    await unhandledApp.close()
  })

  it('aborts service binding signal when SSE connection terminates', async () => {
    let serviceSignal: AbortSignal | undefined

    const declaration = route()
      .events<{ ping: string }>({ heartbeat: false })
      .handler(() => ({
        onOpen() {},
      }))

    const testService = {
      createRuntime: () => ({
        prepare: () => ({
          create: () => ({
            createBinding(bindingCtx: any) {
              serviceSignal = bindingCtx.signal
              return {}
            },
          }),
        }),
      }),
    }

    const definition = createDefinition({
      services: { testService: testService as any },
      routes: [entry('service-abort.sse.ts', declaration)],
    })

    const app = await createApp(definition, { env: {} })
    const res = await app.fetch(new Request('https://example.test/api/service-abort'))
    const reader = res.body!.getReader()

    expect(serviceSignal).toBeDefined()
    expect(serviceSignal!.aborted).toBe(false)

    await reader.cancel()
    await new Promise((r) => setTimeout(r, 40))
    expect(serviceSignal!.aborted).toBe(true)
    await app.close()
  })
})

describe('SSE cancellation and event resource ownership', () => {
  it('upgrades a graceful close to forced cancellation without reporting normal write cancellation', async () => {
    const entered = Promise.withResolvers<SseStream<{ tick: number }>>()
    const finished = Promise.withResolvers<void>()
    const errors: unknown[] = []
    const app = await createApp(
      createDefinition({
        routes: [
          entry(
            'blocked.sse.ts',
            route()
              .events<{ tick: number }>({ heartbeat: false })
              .handler(() => ({
                async onOpen(stream) {
                  entered.resolve(stream)
                  try {
                    for (let i = 0; i < 20; i++) await stream.send('tick', i)
                  } finally {
                    finished.resolve()
                  }
                },
                onError(_stream, error) {
                  errors.push(error)
                },
              })),
          ),
        ],
      }),
    )
    const response = await app.fetch(new Request('http://example.test/api/blocked'))
    try {
      const stream = await entered.promise
      stream.close()
      applicationLifecycles.get(app)!.cancel(new Error('shutdown deadline'))
      await finished.promise
      await response.body!.cancel()
      expect(errors).toEqual([])
    } finally {
      await response.body!.cancel()
      await app.close().catch(() => {})
    }
  })

  it('preserves the parent cancellation reason for connection services', async () => {
    const controller = new AbortController()
    const reason = new Error('request disconnected')
    let signal: AbortSignal | undefined
    const app = await createApp(
      createDefinition({
        routes: [
          entry(
            'reason.sse.ts',
            route()
              .events({ heartbeat: false })
              .handler(() => {
                signal = getCurrentScope()!.signal
                return {}
              }),
          ),
        ],
      }),
    )
    const response = await app.fetch(
      new Request('http://example.test/api/reason', { signal: controller.signal }),
    )
    try {
      controller.abort(reason)
      expect(signal!.reason).toBe(reason)
    } finally {
      await response.body!.cancel()
      await app.close()
    }
  })

  it('retains event services through producer and onClose completion when the body is cancelled', async () => {
    const entered = Promise.withResolvers<void>()
    const releaseProducer = Promise.withResolvers<void>()
    const closeEntered = Promise.withResolvers<void>()
    const releaseClose = Promise.withResolvers<void>()
    const background: Promise<unknown>[] = []
    const dispose = vi.fn()
    const service: ServiceAssembly = {
      createRuntime: () => ({
        prepare: () => ({
          create(_resources, context) {
            context.registerDispose('probe', dispose)
            return {}
          },
        }),
      }),
    }
    const handler = createWorkerHandler(
      createDefinition({
        services: { probe: service },
        routes: [
          entry(
            'owned.sse.ts',
            route()
              .events({ heartbeat: false })
              .handler(() => ({
                async onOpen() {
                  entered.resolve()
                  await releaseProducer.promise
                },
                async onClose() {
                  closeEntered.resolve()
                  await releaseClose.promise
                },
              })),
          ),
        ],
      }),
    )
    const response = await handler.fetch(
      new Request('http://example.test/api/owned'),
      {},
      {
        waitUntil(work) {
          background.push(work)
        },
        passThroughOnException() {},
      },
    )
    let cancellation: Promise<void> | undefined
    try {
      await entered.promise
      cancellation = response.body!.cancel()
      expect(dispose).not.toHaveBeenCalled()
      releaseProducer.resolve()
      await closeEntered.promise
      expect(dispose).not.toHaveBeenCalled()
      releaseClose.resolve()
      await cancellation
      await Promise.all(background)
      expect(dispose).toHaveBeenCalledOnce()
    } finally {
      releaseProducer.resolve()
      releaseClose.resolve()
      await cancellation
      await Promise.allSettled(background)
    }
  })
})

describe('SSE reconnect and response cleanup', () => {
  it.each([
    ['id: 5\n\nretry: 0\n\n', '5'],
    ['id: 访客\n\nretry: 0\n\n', '\xe8\xae\xbf\xe5\xae\xa2'],
    ['id: 5\ndata: 1\n\nid: truncated\ndata: 2\n', '5'],
    ['id: 5\n\nid:\n\nretry: 0\n\n', null],
  ])('commits only completed ID blocks: %s', async (body, expectedId) => {
    const reconnect = Promise.withResolvers<string | null>()
    let attempts = 0
    const client = createClient({
      baseUrl: 'http://example.test/api',
      fetch: async (request) => {
        if (attempts++ === 0)
          return new Response('retry: 0\n' + body, {
            headers: { 'Content-Type': 'text/event-stream' },
          })
        reconnect.resolve(request.headers.get('Last-Event-ID'))
        return new Response(null, { status: 204 })
      },
    })
    const connection = client.sse('/events', { headers: { 'Last-Event-ID': 'initial' } })
    try {
      expect(await reconnect.promise).toBe(expectedId)
    } finally {
      connection.close()
    }
  })

  it('stops all subsequent delivery in a chunk when an event handler closes', async () => {
    const first = Promise.withResolvers<void>()
    const values: number[] = []
    const client = createClient({
      baseUrl: 'http://example.test/api',
      fetch: async () =>
        new Response('event: tick\ndata: 1\n\nevent: tick\ndata: 2\n\n', {
          headers: { 'Content-Type': 'text/event-stream' },
        }),
    })
    const connection = client.sse('/events')
    connection.on('tick', (value) => {
      values.push(value as number)
      connection.close()
      first.resolve()
    })
    connection.on('tick', () => {
      values.push(99)
    })
    try {
      await first.promise
      await Promise.resolve()
      expect(values).toEqual([1])
    } finally {
      connection.close()
    }
  })

  it('cancels an invalid media response and releases its reader', async () => {
    const cancelled = Promise.withResolvers<void>()
    const error = Promise.withResolvers<unknown>()
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled.resolve()
      },
    })
    const client = createClient({
      baseUrl: 'http://example.test/api',
      fetch: async () => new Response(body, { headers: { 'Content-Type': 'text/html' } }),
    })
    const connection = client.sse('/events')
    connection.onError(error.resolve)
    try {
      expect(await error.promise).toBeInstanceOf(HttpError)
      await cancelled.promise
      expect(body.locked).toBe(false)
    } finally {
      connection.close()
    }
  })

  it('does not fetch after closing while an asynchronous headers factory is pending', async () => {
    const entered = Promise.withResolvers<void>()
    const headers = Promise.withResolvers<HeadersInit>()
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }))
    const client = createClient({
      baseUrl: 'http://example.test/api',
      headers: () => {
        entered.resolve()
        return headers.promise
      },
      fetch: fetcher,
    })
    const connection = client.sse('/events')
    try {
      await entered.promise
      connection.close()
      headers.resolve({})
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(fetcher).not.toHaveBeenCalled()
    } finally {
      headers.resolve({})
      connection.close()
    }
  })
})

it.each([false, true])(
  'finishes SSE work when post-middleware rejects the response (keepBody=%s)',
  async (keepBody) => {
    let finished = false
    const app = await createApp(
      createDefinition({
        app: defineApp({
          middleware: [
            async (ctx, next) => {
              await next()
              if (keepBody) {
                ctx.res = new Response(ctx.res.body, { status: 403, headers: ctx.res.headers })
                return
              }
              return ctx.text('denied', 403)
            },
          ],
        }),
        routes: [
          entry(
            'replaced.sse.ts',
            route()
              .events({ heartbeat: false })
              .handler(() => ({
                async onOpen(stream) {
                  if (!stream.signal.aborted)
                    await new Promise<void>((resolve) =>
                      stream.signal.addEventListener('abort', () => resolve(), { once: true }),
                    )
                },
                onClose() {
                  finished = true
                },
              })),
          ),
        ],
      }),
    )
    try {
      const response = await app.fetch(new Request('http://example.test/api/replaced'))
      expect(response.status).toBe(403)
      expect(await response.text()).toBe(keepBody ? '' : 'denied')
      expect(finished).toBe(true)
      expect(applicationLifecycles.get(app)!.pendingRequests).toBe(0)
    } finally {
      await app.close()
    }
  },
)

it('stops error and event delivery when an error listener closes the subscription', async () => {
  const stopped = Promise.withResolvers<void>()
  const laterError = vi.fn()
  const laterEvent = vi.fn()
  const client = createClient({
    baseUrl: 'http://example.test/api',
    fetch: async () =>
      new Response('data: invalid-json\n\nevent: tick\ndata: 2\n\n', {
        headers: { 'Content-Type': 'text/event-stream' },
      }),
  })
  const connection = client.sse('/events')
  connection.onError(() => {
    connection.close()
    stopped.resolve()
  })
  connection.onError(laterError)
  connection.on('tick', laterEvent)
  try {
    await stopped.promise
    expect(laterError).not.toHaveBeenCalled()
    expect(laterEvent).not.toHaveBeenCalled()
  } finally {
    connection.close()
  }
})

it('reports callback errors without recursive error dispatch or reconnecting the live stream', async () => {
  const payload = 'x'.repeat(20000)
  const bytes = new TextEncoder().encode(
    `data: ${JSON.stringify(payload)}\r\n\r\ndata: "second"\r\n\r\n`,
  )
  const response = new Response(
    new ReadableStream({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7))
        controller.close()
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  )
  const transport = vi.fn(async () => response)
  const client = createClient<{
    '/events': { SSE: { input: {}; output: Response; events: { message: string } } }
  }>({ baseUrl: 'https://example.test', fetch: transport })
  const errors: unknown[] = [],
    messages: string[] = []
  const failure = new Error('consumer failed')
  const callbackFailure = new Error('error listener failed')
  const reported = vi.spyOn(console, 'error').mockImplementation(() => {})
  const done = Promise.withResolvers<void>()
  const connection = client.sse('/events')
  connection.onError((error) => {
    errors.push(error)
    throw callbackFailure
  })
  connection.on('message', (value) => {
    messages.push(value)
    if (value === payload) throw failure
    connection.close()
    done.resolve()
  })
  try {
    await done.promise
    expect(messages).toEqual([payload, 'second'])
    expect(errors).toEqual([failure])
    expect(reported).toHaveBeenCalledWith('SSE error callback failed', callbackFailure)
    expect(transport).toHaveBeenCalledOnce()
  } finally {
    connection.close()
    reported.mockRestore()
  }
})

it('retries temporary header failures with the default delay and refreshes credentials and Last-Event-ID on retry zero', async () => {
  vi.useFakeTimers()
  let attempts = 0
  const failure = new Error('Temporary credential refresh failure')
  const requests: Request[] = []
  const client = createClient<{
    '/events': {
      SSE: { input: { query: { q: string } }; output: Response; events: { message: string } }
    }
  }>({
    baseUrl: 'https://example.test/api',
    headers: async () => {
      attempts++
      if (attempts === 1) throw failure
      return { authorization: `token-${attempts}` }
    },
    fetch: async (request) => {
      requests.push(request)
      return requests.length === 1
        ? new Response('id: first\nretry: 0\ndata: "one"\n\n', {
            headers: { 'content-type': 'text/event-stream' },
          })
        : new Response(null, { status: 204 })
    },
  })
  const query = { q: 'initial' }
  const headers = { 'X-Choice': 'initial' }
  const errors: unknown[] = []
  const connection = client.sse('/events', { query, headers, init: { credentials: 'include' } })
  connection.onError((error) => errors.push(error))
  query.q = 'changed'
  headers['X-Choice'] = 'changed'
  try {
    await vi.advanceTimersByTimeAsync(2999)
    expect(requests).toHaveLength(0)
    expect(errors).toEqual([failure])
    await vi.advanceTimersByTimeAsync(2)
    expect(requests).toHaveLength(2)
    expect(requests[0]).not.toBe(requests[1])
    expect(requests.map((request) => request.headers.get('authorization'))).toEqual([
      'token-2',
      'token-3',
    ])
    expect(requests.map((request) => request.headers.get('Last-Event-ID'))).toEqual([null, 'first'])
    expect(
      requests.every(
        (request) =>
          request.url === 'https://example.test/api/events?q=initial' &&
          request.credentials === 'include' &&
          request.headers.get('X-Choice') === 'initial',
      ),
    ).toBe(true)
  } finally {
    connection.close()
    vi.useRealTimers()
  }
})
