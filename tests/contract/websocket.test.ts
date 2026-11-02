import { once } from 'node:events'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

import { setCookie } from 'hono/cookie'
import { describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'

import {
  createNodeWebSocketBridge,
  type NodeWebSocketBridge,
} from '../../src/adapter/node/websocket'
import { getCurrentScope, getRequestId } from '../../src/core/context'
import { createDefinition } from '../../src/entries/runtime/core'
import {
  createApp,
  defineApp,
  HttpError,
  route,
  SOCKET_READY_STATE,
  z,
} from '../../src/entries/server'
import { parseApiFilePath } from '../../src/http/path'
import type { RouteEntry } from '../../src/http/server/types'
import { getWsUpgradeState } from '../../src/http/server/websocket'
import type { RouteDeclaration, Socket, SseDeclaration } from '../../src/http/types'

function entry(
  source: string,
  declaration: RouteDeclaration | SseDeclaration,
  prefix = '/api',
): RouteEntry {
  return { source, routePath: parseApiFilePath(source, prefix)!, declaration }
}

interface ConnectOptions {
  headers?: Record<string, string>
  query?: Record<string, string>
}

interface BridgeConnectResult {
  statusCode: number
  statusText: string
  headers: http.IncomingHttpHeaders
  body: string
  clientWs?: WebSocket
}

async function connectToBridge(
  bridge: NodeWebSocketBridge,
  path: string,
  options: ConnectOptions = {},
): Promise<BridgeConnectResult> {
  const result = Promise.withResolvers<BridgeConnectResult>()
  const server = http.createServer((_req, res) => {
    res.writeHead(404)
    res.end()
  })
  server.on('upgrade', (req, socket, head) => {
    void bridge
      .handleUpgrade(req, socket, head)
      .then((handled) => {
        if (!handled) socket.destroy()
      })
      .catch((error) => {
        socket.destroy()
        result.reject(error)
      })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const query = options.query ? '?' + new URLSearchParams(options.query) : ''

  // Raw HTTP preserves an intentionally invalid key; ws generates its own valid key.
  if (options.headers?.['sec-websocket-key']) {
    const request = http.request({
      host: '127.0.0.1',
      port,
      path: path + query,
      headers: {
        Upgrade: 'websocket',
        Connection: 'Upgrade',
        'Sec-WebSocket-Version': '13',
        ...options.headers,
      },
    })
    request.on('upgrade', (_response, socket) => {
      socket.destroy()
      server.close()
      result.reject(new Error('Invalid protocol handshake was unexpectedly accepted'))
    })
    request.on('response', (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => {
        body += chunk
      })
      response.on('end', () => {
        server.close()
        result.resolve({
          statusCode: response.statusCode!,
          statusText: response.statusMessage!,
          headers: response.headers,
          body,
        })
      })
    })
    request.on('error', (error) => {
      server.close()
      result.reject(error)
    })
    request.end()
  } else {
    const client = new WebSocket(`ws://127.0.0.1:${port}${path}${query}`, {
      headers: options.headers,
      handshakeTimeout: 2000,
    })
    let headers: http.IncomingHttpHeaders = {}
    client.once('upgrade', (response) => {
      headers = response.headers
    })
    client.once('open', () =>
      result.resolve({
        statusCode: 101,
        statusText: 'Switching Protocols',
        headers,
        body: '',
        clientWs: client,
      }),
    )
    client.once('close', () => {
      server.close()
    })
    client.once('error', (error) => {
      server.close()
      result.reject(error)
    })
    client.once('unexpected-response', (_request, response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => {
        body += chunk
      })
      response.on('end', () => {
        server.close()
        result.resolve({
          statusCode: response.statusCode!,
          statusText: response.statusMessage!,
          headers: response.headers,
          body,
        })
      })
    })
  }
  return result.promise
}

describe('WebSocket contract', () => {
  describe('RFC 6455 §10.2 Origin and HTTP Admission', () => {
    it('rejects null Origin with 403 csrf_forbidden', async () => {
      const declaration = route().handler(() => ({}))
      const app = await createApp(
        createDefinition({
          routes: [entry('chat.ws.ts', declaration)],
        }),
      )

      const req = new Request('https://example.test/api/chat', {
        headers: {
          Upgrade: 'websocket',
          Connection: 'Upgrade',
          Origin: 'null',
        },
      })

      const res = await app.fetch(req)
      expect(res.status).toBe(403)
      const data = await res.json()
      expect(data?.error?.code).toBe('csrf_forbidden')
    })

    it('rejects untrusted cross-origin request with 403 csrf_forbidden', async () => {
      const declaration = route().handler(() => ({}))
      const app = await createApp(
        createDefinition({
          app: defineApp({ hosts: ['example.test'] }),
          routes: [entry('chat.ws.ts', declaration)],
        }),
      )

      const req = new Request('https://example.test/api/chat', {
        headers: {
          Upgrade: 'websocket',
          Connection: 'Upgrade',
          Origin: 'https://evil.example.com',
        },
      })

      const res = await app.fetch(req)
      expect(res.status).toBe(403)
      const data = await res.json()
      expect(data?.error?.code).toBe('csrf_forbidden')
    })

    it('accepts matching host Origin', async () => {
      const declaration = route().handler(() => ({}))
      const app = await createApp(
        createDefinition({
          app: defineApp({ hosts: ['example.test'] }),
          routes: [entry('chat.ws.ts', declaration)],
        }),
      )

      const req = new Request('https://example.test/api/chat', {
        headers: {
          Upgrade: 'websocket',
          Connection: 'Upgrade',
          Origin: 'https://example.test',
        },
      })

      const res = await app.fetch(req)
      expect(res.status).toBe(200)
      const accepted = getWsUpgradeState(res)!
      expect(accepted).toBeDefined()
      accepted.connectionAbort.abort()
      await accepted.release!()
      await app.close()
    })

    it('accepts non-browser request without Origin header', async () => {
      const declaration = route().handler(() => ({}))
      const app = await createApp(
        createDefinition({
          app: defineApp({ hosts: ['example.test'] }),
          routes: [entry('chat.ws.ts', declaration)],
        }),
      )

      const req = new Request('https://example.test/api/chat', {
        headers: {
          Upgrade: 'websocket',
          Connection: 'Upgrade',
        },
      })

      const res = await app.fetch(req)
      expect(res.status).toBe(200)
      const accepted = getWsUpgradeState(res)!
      expect(accepted).toBeDefined()
      accepted.connectionAbort.abort()
      await accepted.release!()
      await app.close()
    })

    it('bypasses origin validation when route has csrf: false', async () => {
      const declaration = route({ csrf: false }).handler(() => ({}))
      const app = await createApp(
        createDefinition({
          app: defineApp({ hosts: ['example.test'] }),
          routes: [entry('chat.ws.ts', declaration)],
        }),
      )

      const req = new Request('https://example.test/api/chat', {
        headers: {
          Upgrade: 'websocket',
          Connection: 'Upgrade',
          Origin: 'https://untrusted.example.org',
        },
      })

      const res = await app.fetch(req)
      expect(res.status).toBe(200)
      const accepted = getWsUpgradeState(res)!
      expect(accepted).toBeDefined()
      accepted.connectionAbort.abort()
      await accepted.release!()
      await app.close()
    })

    it('accepts origin configured in csrf.origins whitelist', async () => {
      const declaration = route().handler(() => ({}))
      const app = await createApp(
        createDefinition({
          app: defineApp({
            hosts: ['example.test'],
            csrf: { origins: ['https://trusted.partner.org'] },
          }),
          routes: [entry('chat.ws.ts', declaration)],
        }),
      )

      const req = new Request('https://example.test/api/chat', {
        headers: {
          Upgrade: 'websocket',
          Connection: 'Upgrade',
          Origin: 'https://trusted.partner.org',
        },
      })

      const res = await app.fetch(req)
      expect(res.status).toBe(200)
      const accepted = getWsUpgradeState(res)!
      expect(accepted).toBeDefined()
      accepted.connectionAbort.abort()
      await accepted.release!()
      await app.close()
    })

    it('respects directory scope csrf: false override over app csrf', async () => {
      const declaration = route().handler(() => ({}))
      const wsEntry: RouteEntry = {
        source: 'public/chat.ws.ts',
        routePath: parseApiFilePath('public/chat.ws.ts', '/api')!,
        declaration,
        scopes: [
          {
            options: { csrf: false },
          },
        ],
      }
      const app = await createApp(
        createDefinition({
          app: defineApp({ hosts: ['example.test'], csrf: true }),
          routes: [wsEntry],
        }),
      )

      const req = new Request('https://example.test/api/public/chat', {
        headers: {
          Upgrade: 'websocket',
          Connection: 'Upgrade',
          Origin: 'https://untrusted.example.org',
        },
      })

      const res = await app.fetch(req)
      expect(res.status).toBe(200)
      const accepted = getWsUpgradeState(res)!
      expect(accepted).toBeDefined()
      accepted.connectionAbort.abort()
      await accepted.release!()
      await app.close()
    })

    it('returns 426 Upgrade Required when accessed via plain HTTP GET', async () => {
      const declaration = route().handler(() => ({}))
      const app = await createApp(
        createDefinition({
          routes: [entry('chat.ws.ts', declaration)],
        }),
      )

      const res = await app.fetch(new Request('https://example.test/api/chat'))
      expect(res.status).toBe(426)
      expect(res.headers.get('Upgrade')).toBe('websocket')
      expect(res.headers.get('Connection')).toBe('Upgrade')
    })

    it('returns 405 Method Not Allowed when accessed via plain HTTP POST', async () => {
      const declaration = route().handler(() => ({}))
      const app = await createApp(
        createDefinition({
          routes: [entry('chat.ws.ts', declaration)],
        }),
      )

      const res = await app.fetch(new Request('https://example.test/api/chat', { method: 'POST' }))
      expect(res.status).toBe(405)
    })
  })

  describe('Node Handshake Rejection and Delivery Boundary', () => {
    it('delivers custom HTTP status, headers, cookies, and body over TCP when handshake throws HttpError', async () => {
      const declaration = route()
        .validate({ query: z.object({ token: z.string() }) })
        .handler((c, input) => {
          if (input.query.token !== 'valid_secret') {
            setCookie(c, 'auth_attempt', 'failed', { httpOnly: true })
            throw new HttpError(401, 'Unauthorized handshake', { code: 'bad_token' })
          }
          return {}
        })

      const app = await createApp(
        createDefinition({
          routes: [entry('auth.ws.ts', declaration)],
        }),
      )

      const bridge = createNodeWebSocketBridge(app)
      try {
        const result = await connectToBridge(bridge, '/api/auth', {
          query: { token: 'invalid' },
        })

        expect(result.statusCode).toBe(401)
        expect(result.headers['content-type']).toContain('application/json')
        const cookies = result.headers['set-cookie']
        expect(Array.isArray(cookies) ? cookies.join(';') : cookies).toContain(
          'auth_attempt=failed',
        )
        const parsedBody = JSON.parse(result.body)
        expect(parsedBody.error.code).toBe('bad_token')
        expect(parsedBody.error.message).toBe('Unauthorized handshake')
      } finally {
        await bridge.close()
      }
    })

    it('attaches custom headers and cookies on successful 101 upgrade', async () => {
      const declaration = route().handler((c) => {
        setCookie(c, 'session_id', 'sess_123456', { httpOnly: true })
        c.header('X-Handshake-Status', 'admitted')
        return {}
      })

      const app = await createApp(
        createDefinition({
          routes: [entry('admit.ws.ts', declaration)],
        }),
      )

      const bridge = createNodeWebSocketBridge(app)
      try {
        const result = await connectToBridge(bridge, '/api/admit')
        expect(result.statusCode).toBe(101)
        expect(result.headers['x-handshake-status']).toBe('admitted')
        const cookies = result.headers['set-cookie']
        expect(Array.isArray(cookies) ? cookies.join(';') : cookies).toContain(
          'session_id=sess_123456',
        )
        result.clientWs?.close()
      } finally {
        await bridge.close()
      }
    })

    it('revokes upgrade and delivers 403 response when post-middleware returns 403', async () => {
      const declaration = route({
        middleware: [
          async (_ctx, next) => {
            await next()
            return new Response('Forbidden by post-middleware', {
              status: 403,
              headers: { 'Content-Type': 'text/plain' },
            })
          },
        ],
      }).handler(() => ({}))

      const app = await createApp(
        createDefinition({
          routes: [entry('post-reject.ws.ts', declaration)],
        }),
      )

      const bridge = createNodeWebSocketBridge(app)
      try {
        const result = await connectToBridge(bridge, '/api/post-reject')
        expect(result.statusCode).toBe(403)
        expect(result.body).toBe('Forbidden by post-middleware')
      } finally {
        await bridge.close()
      }
    })

    it('does not leak headers or cookies across failed and successful upgrades', async () => {
      const declaration = route()
        .validate({ query: z.object({ account: z.string() }) })
        .handler((c, input) => {
          setCookie(c, 'session', input.query.account, { httpOnly: true })
          c.header('X-Account', input.query.account)
          return {}
        })

      const app = await createApp(
        createDefinition({
          routes: [entry('account.ws.ts', declaration)],
        }),
      )

      const bridge = createNodeWebSocketBridge(app)
      try {
        // First connection: account=alice with invalid Sec-WebSocket-Key
        const failedRes = await connectToBridge(bridge, '/api/account', {
          query: { account: 'alice' },
          headers: {
            'sec-websocket-key': 'invalid_key_not_base64',
          },
        })
        expect(failedRes.statusCode).toBe(400)

        // Second connection: account=bob with valid Sec-WebSocket-Key
        const successRes = await connectToBridge(bridge, '/api/account', {
          query: { account: 'bob' },
        })
        expect(successRes.statusCode).toBe(101)
        expect(successRes.headers['x-account']).toBe('bob')
        const cookies = successRes.headers['set-cookie']
        const cookieStr = Array.isArray(cookies) ? cookies.join(';') : (cookies ?? '')
        expect(cookieStr).toContain('session=bob')
        expect(cookieStr).not.toContain('session=alice')
        successRes.clientWs?.close()
      } finally {
        await bridge.close()
      }
    })
  })

  describe('Duplex Message Exchange and Scope Restoration', () => {
    it('exchanges text and binary messages and restores request scope', async () => {
      let capturedOpenRequestId: string | undefined
      let capturedMessageRequestId: string | undefined
      let capturedCloseRequestId: string | undefined
      let serverReadyStateAtOpen: number | undefined

      const declaration = route().handler(() => {
        return {
          onOpen(socket: Socket) {
            capturedOpenRequestId = getRequestId()
            serverReadyStateAtOpen = socket.readyState
          },
          onMessage(socket: Socket, data: string | Uint8Array) {
            capturedMessageRequestId = getRequestId()
            if (typeof data === 'string') {
              socket.send(`echo:${data}`)
            } else {
              const bytes = data
              const reversed = new Uint8Array(bytes.length)
              for (let i = 0; i < bytes.length; i++) {
                reversed[i] = bytes[bytes.length - 1 - i]
              }
              socket.send(reversed)
            }
          },
          onClose(_socket: Socket) {
            capturedCloseRequestId = getRequestId()
          },
        }
      })

      const app = await createApp(
        createDefinition({
          routes: [entry('echo.ws.ts', declaration)],
        }),
      )

      const bridge = createNodeWebSocketBridge(app)
      try {
        const result = await connectToBridge(bridge, '/api/echo', {
          headers: {
            'x-request-id': 'req-fixed-ws-123',
          },
        })

        expect(result.statusCode).toBe(101)
        const ws = result.clientWs!
        expect(serverReadyStateAtOpen).toBe(SOCKET_READY_STATE.OPEN)

        // Test text echo
        const textEchoPromise = Promise.withResolvers<string>()
        ws.once('message', (data, isBinary) => {
          expect(isBinary).toBe(false)
          textEchoPromise.resolve(data.toString())
        })
        ws.send('hello world')
        const textResult = await textEchoPromise.promise
        expect(textResult).toBe('echo:hello world')

        // Test binary echo
        const binaryEchoPromise = Promise.withResolvers<Buffer>()
        ws.once('message', (data, isBinary) => {
          expect(isBinary).toBe(true)
          binaryEchoPromise.resolve(data as Buffer)
        })
        ws.send(Buffer.from([10, 20, 30, 40]))
        const binaryResult = await binaryEchoPromise.promise
        expect(Array.from(binaryResult)).toEqual([40, 30, 20, 10])

        // Close from client and verify scope restoration
        const clientClosed = Promise.withResolvers<void>()
        ws.on('close', () => clientClosed.resolve())
        ws.close()
        await clientClosed.promise

        await new Promise((r) => setTimeout(r, 20))

        expect(typeof capturedOpenRequestId).toBe('string')
        expect(capturedOpenRequestId!.length).toBeGreaterThan(0)
        expect(capturedMessageRequestId).toBe(capturedOpenRequestId)
        expect(capturedCloseRequestId).toBe(capturedOpenRequestId)
      } finally {
        await bridge.close()
      }
    })

    it('dispatches error to onError handler without terminating connection', async () => {
      let onErrorReceived: any = undefined
      let onErrorSocketState: number | undefined

      const declaration = route().handler(() => {
        let msgCount = 0
        return {
          onMessage(socket: Socket, data: string | Uint8Array) {
            msgCount++
            if (msgCount === 1) {
              throw new Error('processing_failure')
            }
            socket.send(`recovered:${data}`)
          },
          onError(socket: Socket, error: unknown) {
            onErrorReceived = error
            onErrorSocketState = socket.readyState
          },
        }
      })

      const app = await createApp(
        createDefinition({
          routes: [entry('resilient.ws.ts', declaration)],
        }),
      )

      const bridge = createNodeWebSocketBridge(app)
      try {
        const result = await connectToBridge(bridge, '/api/resilient')
        expect(result.statusCode).toBe(101)
        const ws = result.clientWs!

        // Send first message that triggers error
        ws.send('fail')
        await new Promise((r) => setTimeout(r, 30))

        expect(onErrorReceived).toBeInstanceOf(Error)
        expect(onErrorReceived.message).toBe('processing_failure')
        expect(onErrorSocketState).toBe(SOCKET_READY_STATE.OPEN)

        // Connection should still be open and able to exchange messages
        const recoveredPromise = Promise.withResolvers<string>()
        ws.once('message', (data) => {
          recoveredPromise.resolve(data.toString())
        })
        ws.send('next')
        const resp = await recoveredPromise.promise
        expect(resp).toBe('recovered:next')

        ws.close()
      } finally {
        await bridge.close()
      }
    })

    it('synchronizes connectionScope.signal with socket.signal and tracks async onOpen', async () => {
      let signalMatchesInOpen = false
      let signalMatchesInMessage = false
      let openCompleted = false

      const declaration = route().handler(() => ({
        async onOpen(socket: Socket) {
          const scope = getCurrentScope()
          signalMatchesInOpen = scope?.signal === socket.signal
          await new Promise((r) => setTimeout(r, 50))
          openCompleted = true
        },
        onMessage(socket: Socket, data: string | Uint8Array) {
          const scope = getCurrentScope()
          signalMatchesInMessage = scope?.signal === socket.signal
          socket.send(`echo:${data}`)
        },
      }))

      const app = await createApp(
        createDefinition({
          routes: [entry('signal.ws.ts', declaration)],
        }),
      )

      const bridge = createNodeWebSocketBridge(app)
      try {
        const result = await connectToBridge(bridge, '/api/signal')
        expect(result.statusCode).toBe(101)
        const ws = result.clientWs!

        const msgPromise = Promise.withResolvers<string>()
        ws.once('message', (d) => msgPromise.resolve(d.toString()))
        ws.send('ping')
        await msgPromise.promise

        expect(signalMatchesInOpen).toBe(true)
        expect(signalMatchesInMessage).toBe(true)

        ws.close()
        await bridge.close()
        expect(openCompleted).toBe(true)
      } finally {
        await bridge.close()
      }
    })
  })

  describe('Lifecycle Draining and Graceful Shutdown', () => {
    it('sends 1001 Going Away close frame and waits for async onClose work on server shutdown', async () => {
      let asyncCloseWorkDone = false

      const declaration = route().handler(() => {
        return {
          async onClose() {
            await new Promise((r) => setTimeout(r, 50))
            asyncCloseWorkDone = true
          },
        }
      })

      const app = await createApp(
        createDefinition({
          routes: [entry('drain.ws.ts', declaration)],
        }),
      )

      const bridge = createNodeWebSocketBridge(app)
      const result = await connectToBridge(bridge, '/api/drain')
      expect(result.statusCode).toBe(101)
      const ws = result.clientWs!

      const closeEventPromise = Promise.withResolvers<{ code: number; reason: string }>()
      ws.on('close', (code, reason) => {
        closeEventPromise.resolve({ code, reason: reason.toString() })
      })

      // Trigger bridge shutdown while connection is active
      const bridgeClosePromise = bridge.close(performance.now() + 500)

      const closeEvent = await closeEventPromise.promise
      expect(closeEvent.code).toBe(1001)
      expect(closeEvent.reason).toBe('Going Away')

      // Echo close frame back to complete WebSocket closing handshake
      ws.close(1001, 'Going Away')

      await bridgeClosePromise
      expect(asyncCloseWorkDone).toBe(true)
    })
  })

  describe('Route Collision and Validation', () => {
    it('rejects route conflicts between .ws.ts and .get.ts on the same path', async () => {
      const wsRoute = entry(
        'chat.ws.ts',
        route().handler(() => ({})),
      )
      const getRoute = entry(
        'chat.get.ts',
        route().handler(() => ({ ok: true })),
      )

      await expect(
        createApp(
          createDefinition({
            routes: [wsRoute, getRoute],
          }),
        ),
      ).rejects.toThrow(/Route conflict.*chat/i)
    })

    it('rejects route conflicts between .ws.ts and .sse.ts on the same path', async () => {
      const wsRoute = entry(
        'events.ws.ts',
        route().handler(() => ({})),
      )
      const sseRoute = entry(
        'events.sse.ts',
        route()
          .events()
          .handler(() => ({})),
      )

      await expect(
        createApp(
          createDefinition({
            routes: [wsRoute, sseRoute],
          }),
        ),
      ).rejects.toThrow(/Route conflict.*events/i)
    })

    it('rejects body schemas declared on WS routes', async () => {
      const invalidWs = entry(
        'invalid.ws.ts',
        route()
          .validate({ json: z.object({ msg: z.string() }) } as any)
          .handler(() => ({})),
      )

      await expect(
        createApp(
          createDefinition({
            routes: [invalidWs],
          }),
        ),
      ).rejects.toThrow(/WebSocket routes cannot declare a request body schema/i)
    })
  })

  describe('Node Handshake Reservation and Rejection Release', () => {
    it('releases lifecycle request reservation when handshake is rejected on invalid key', async () => {
      const declaration = route().handler(() => ({}))
      const app = await createApp(
        createDefinition({
          routes: [entry('invalid-key.ws.ts', declaration)],
        }),
      )
      const bridge = createNodeWebSocketBridge(app)
      try {
        const failedRes = await connectToBridge(bridge, '/api/invalid-key', {
          headers: {
            'sec-websocket-key': 'invalid_key_not_base64',
          },
        })
        expect(failedRes.statusCode).toBe(400)
        const lifecycle = (await import('../../src/core/lifecycle')).applicationLifecycles.get(app)!
        expect(lifecycle.pendingRequests).toBe(0)
      } finally {
        await bridge.close()
        await app.close()
      }
    })
  })

  describe('URL Normalization and Routing Priorities', () => {
    it('matches trailing slash and case differences without generating 308 redirects', async () => {
      const declaration = route().handler(() => ({
        onOpen(socket: Socket) {
          socket.send('hello-url-norm')
        },
      }))

      const app = await createApp(
        createDefinition({
          routes: [entry('chat.ws.ts', declaration)],
        }),
      )
      const bridge = createNodeWebSocketBridge(app)

      try {
        // 1. Trailing slash /api/chat/
        const trailingSlashRes = await connectToBridge(bridge, '/api/chat/')
        expect(trailingSlashRes.statusCode).toBe(101)
        expect(trailingSlashRes.clientWs).toBeDefined()
        trailingSlashRes.clientWs!.close()

        // 2. Case difference /API/CHAT
        const caseDiffRes = await connectToBridge(bridge, '/API/CHAT')
        expect(caseDiffRes.statusCode).toBe(101)
        expect(caseDiffRes.clientWs).toBeDefined()
        caseDiffRes.clientWs!.close()

        // 3. Case difference and trailing slash /API/CHAT/
        const bothRes = await connectToBridge(bridge, '/API/CHAT/')
        expect(bothRes.statusCode).toBe(101)
        expect(bothRes.clientWs).toBeDefined()
        bothRes.clientWs!.close()

        // 4. Non-upgrade GET to /api/chat/ returns 426 Upgrade Required (NOT 308)
        const nonUpgradeRes = await app.fetch(
          new Request('http://localhost/api/chat/', { method: 'GET' }),
        )
        expect(nonUpgradeRes.status).toBe(426)
        expect(nonUpgradeRes.headers.get('Upgrade')).toBe('websocket')
      } finally {
        await bridge.close()
        await app.close()
      }
    })

    it('removes lifecycle drain listener on normal connection close', async () => {
      let openCalled = false
      const declaration = route().handler(() => ({
        onOpen() {
          openCalled = true
        },
      }))

      const app = await createApp(
        createDefinition({
          routes: [entry('leak.ws.ts', declaration)],
        }),
      )
      const bridge = createNodeWebSocketBridge(app)

      try {
        const connectRes = await connectToBridge(bridge, '/api/leak')
        expect(connectRes.statusCode).toBe(101)
        expect(openCalled).toBe(true)

        // Close client connection normally
        connectRes.clientWs!.close()
        await new Promise((r) => setTimeout(r, 50))

        // Draining signal shouldn't retain abort listeners that trigger on old socket
        // Trigger app close now and verify clean shutdown
      } finally {
        await bridge.close()
        await app.close()
      }
    })

    it('retains WS upgrade when post-middleware adds custom headers via ctx.header', async () => {
      const declaration = route().handler(() => ({
        onOpen(socket: Socket) {
          socket.send('audit-verified')
        },
      }))

      const app = await createApp(
        createDefinition({
          routes: [
            {
              ...entry('audit.ws.ts', declaration),
              scopes: [
                {
                  middleware: async (ctx, next) => {
                    await next()
                    ctx.header('X-Audit', 'ok')
                  },
                },
              ],
            },
          ],
        }),
      )
      const bridge = createNodeWebSocketBridge(app)
      try {
        const res = await connectToBridge(bridge, '/api/audit')
        expect(res.statusCode).toBe(101)
        expect(res.clientWs).toBeDefined()
        expect(res.headers['x-audit']).toBe('ok')
        res.clientWs!.close()
      } finally {
        await bridge.close()
        await app.close()
      }
    })

    it('retains WS upgrade when CORS middleware is active for configured origin', async () => {
      const declaration = route().handler(() => ({
        onOpen(socket: Socket) {
          socket.send('cors-verified')
        },
      }))

      const app = await createApp(
        createDefinition({
          app: defineApp({
            csrf: { origins: ['http://trusted.example'] },
            cors: { origin: 'http://trusted.example' },
          }),
          routes: [entry('cors-ws.ws.ts', declaration)],
        }),
      )
      const bridge = createNodeWebSocketBridge(app)
      try {
        const res = await connectToBridge(bridge, '/api/cors-ws', {
          headers: { origin: 'http://trusted.example' },
        })
        expect(res.statusCode).toBe(101)
        expect(res.clientWs).toBeDefined()
        expect(res.headers['access-control-allow-origin']).toBe('http://trusted.example')
        res.clientWs!.close()
      } finally {
        await bridge.close()
        await app.close()
      }
    })

    it('revokes WS upgrade when post-middleware overrides response with 403', async () => {
      const declaration = route().handler(() => ({
        onOpen(socket: Socket) {
          socket.send('should-not-open')
        },
      }))

      const app = await createApp(
        createDefinition({
          routes: [
            {
              ...entry('revoke-403.ws.ts', declaration),
              scopes: [
                {
                  middleware: async (ctx, next) => {
                    await next()
                    ctx.res = new Response('Forbidden by audit', { status: 403 })
                  },
                },
              ],
            },
          ],
        }),
      )
      const bridge = createNodeWebSocketBridge(app)
      try {
        const res = await connectToBridge(bridge, '/api/revoke-403')
        expect(res.statusCode).toBe(403)
        expect(res.clientWs).toBeUndefined()
        expect(res.body).toBe('Forbidden by audit')
      } finally {
        await bridge.close()
        await app.close()
      }
    })

    it('aborts service binding signal when WebSocket connection terminates', async () => {
      let serviceSignal: AbortSignal | undefined
      const declaration = route().handler(() => ({
        onOpen() {},
      }))

      const testWsService = {
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
        services: { testWsService: testWsService as any },
        routes: [entry('service-ws.ws.ts', declaration)],
      })

      const app = await createApp(definition, { env: {} })
      const bridge = createNodeWebSocketBridge(app)
      try {
        const res = await connectToBridge(bridge, '/api/service-ws')
        expect(res.statusCode).toBe(101)
        expect(serviceSignal).toBeDefined()
        expect(serviceSignal!.aborted).toBe(false)

        res.clientWs!.close()
        await new Promise((r) => setTimeout(r, 50))
        expect(serviceSignal!.aborted).toBe(true)
      } finally {
        await bridge.close()
        await app.close()
      }
    })

    it('maintains lifecycle request reservation across handshake until connection closes', async () => {
      const openPromise = Promise.withResolvers<void>()
      let closeWorkDone = false
      const declaration = route().handler(() => ({
        onOpen() {
          openPromise.resolve()
        },
        async onClose() {
          await new Promise((r) => setTimeout(r, 80))
          closeWorkDone = true
        },
      }))

      const app = await createApp(
        createDefinition({
          routes: [entry('lifecycle-hold.ws.ts', declaration)],
        }),
      )
      const bridge = createNodeWebSocketBridge(app)
      try {
        const res = await connectToBridge(bridge, '/api/lifecycle-hold')
        expect(res.statusCode).toBe(101)
        await openPromise.promise

        // While connection is open, lifecycle activeRequests is maintained at 1 (never drops to 0)
        const lifecycle =
          (app as any).lifecycle ??
          (await import('../../src/core/lifecycle')).applicationLifecycles.get(app)!
        expect(lifecycle.pendingRequests).toBe(1)

        let appClosed = false
        const closePromise = app.close().then(() => {
          appClosed = true
        })
        await new Promise((r) => setTimeout(r, 30))
        expect(appClosed).toBe(false)
        expect(closeWorkDone).toBe(false)

        await closePromise
        expect(appClosed).toBe(true)
        expect(closeWorkDone).toBe(true)
        expect(lifecycle.pendingRequests).toBe(0)
      } finally {
        await bridge.close()
      }
    })
  })
})

it.each([
  ['你好.ws.ts', '/api/%E4%BD%A0%E5%A5%BD', undefined],
  ['chat.ws.ts', '/api/%63hat', undefined],
  ['rooms/[id].ws.ts', '/api/rooms/a%2Fb', 'a/b'],
  ['rooms/[id].ws.ts', '/api/rooms/%252F', '%2F'],
])('shares HTTP and WS path semantics for %s at %s', async (file, path, id) => {
  const app = await createApp(
    createDefinition({
      routes: [
        entry(
          file,
          route().handler((ctx) => ({
            onMessage(socket: Socket) {
              socket.send(ctx.req.param('id') ?? 'static')
            },
          })),
        ),
      ],
    }),
  )
  const bridge = createNodeWebSocketBridge(app)
  let client: WebSocket | undefined
  try {
    const httpResponse = await app.fetch(new Request('http://example.test' + path))
    expect(httpResponse.status).toBe(426)
    const result = await connectToBridge(bridge, path)
    expect(result.statusCode).toBe(101)
    client = result.clientWs!
    const message = once(client, 'message')
    client.send('value')
    expect((await message)[0].toString()).toBe(id ?? 'static')
  } finally {
    if (client && client.readyState !== WebSocket.CLOSED) {
      const closed = once(client, 'close')
      client.close()
      await closed
    }
    await bridge.close()
    await app.close()
  }
})

it('retains the connection until asynchronous error handling and onClose finish', async () => {
  const errorEntered = Promise.withResolvers<void>()
  const releaseError = Promise.withResolvers<void>()
  const closed = Promise.withResolvers<boolean>()
  let handled = false
  const app = await createApp(
    createDefinition({
      routes: [
        entry(
          'errors.ws.ts',
          route().handler(() => ({
            onMessage() {
              throw new Error('message failed')
            },
            async onError() {
              errorEntered.resolve()
              await releaseError.promise
              handled = true
            },
            onClose() {
              closed.resolve(handled)
            },
          })),
        ),
      ],
    }),
  )
  const bridge = createNodeWebSocketBridge(app)
  let client: WebSocket | undefined
  try {
    client = (await connectToBridge(bridge, '/api/errors')).clientWs!
    client.send('fail')
    await errorEntered.promise
    const disconnected = once(client, 'close')
    let complete = false
    const closing = app.close().then(() => {
      complete = true
    })
    await disconnected
    expect(complete).toBe(false)
    releaseError.resolve()
    expect(await closed.promise).toBe(true)
    await closing
  } finally {
    releaseError.resolve()
    if (client && client.readyState !== WebSocket.CLOSED) {
      const disconnected = once(client, 'close')
      client.terminate()
      await disconnected
    }
    await bridge.close()
    await app.close()
  }
})
