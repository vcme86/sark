/**
 * Unified Node WebSocket bridge shared by production HTTP server and Vite dev server.
 *
 * @module
 */

import http from 'node:http'
import type { Socket as NodeSocket } from 'node:net'
import type { Duplex } from 'node:stream'

import { getRequestListener } from '@hono/node-server'
import { TrieRouter } from 'hono/router/trie-router'
import { type RawData, type WebSocket, WebSocketServer } from 'ws'

import type { RequestScope } from '../../app/context'
import type { RouteEntry } from '../../app/http/assembly'
import { formatErrorResponse } from '../../app/http/output'
import type { SocketHandlers } from '../../app/http/types'
import {
  createWebSocketConnectionRunner,
  getWsUpgradeState,
  type PlatformSocketTransport,
  type WebSocketConnectionRunner,
} from '../../app/http/websocket'
import { applicationLifecycles, type LifecycleManager } from '../../app/lifecycle'
import type { AppInstance } from '../../app/types'
import { compareRoutes, createRequestPathResolver } from '../../http/path'

/**
 * Delivers an HTTP rejection, including its body and cookies, on an upgrade socket.
 *
 * @param incoming - Original Node upgrade request.
 * @param socket - Socket still owned by the HTTP handshake.
 * @param response - Final rejection from the application pipeline.
 * @returns Resolves after response delivery finishes or the peer closes the socket.
 * @throws If response delivery fails.
 */
export async function writeServerResponse(
  incoming: http.IncomingMessage,
  socket: Duplex,
  response: Response,
): Promise<void> {
  const outgoing = new http.ServerResponse(incoming)
  outgoing.assignSocket(socket as NodeSocket)
  outgoing.shouldKeepAlive = false

  const deliver = getRequestListener(() => response, { overrideGlobalObjects: false })
  const finished = new Promise<void>((resolve) => {
    outgoing.once('finish', () => {
      socket.end()
      resolve()
    })
    outgoing.once('close', () => {
      socket.destroy()
      resolve()
    })
  })

  try {
    await deliver(incoming, outgoing)
  } catch (error) {
    socket.destroy()
    throw error
  }
  await finished
}

/** Converts an incoming Node HTTP message into a standard Fetch Request. */
function incomingToRequest(incoming: http.IncomingMessage, signal: AbortSignal): Request {
  const host = incoming.headers.host || 'localhost'
  const protocol = 'encrypted' in incoming.socket && incoming.socket.encrypted ? 'https:' : 'http:'
  const url = new URL(incoming.url || '/', `${protocol}//${host}`).href

  const headers = new Headers()
  for (const [key, value] of Object.entries(incoming.headers)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v)
    } else {
      headers.set(key, value)
    }
  }

  return new Request(url, {
    method: incoming.method || 'GET',
    headers,
    signal,
  })
}

/** Options configuring the Node.js WebSocket wrapper. */
interface NodeWebSocketOptions {
  ws: WebSocket
  handlers: SocketHandlers
  connectionScope: RequestScope
  lifecycle?: LifecycleManager
  release: () => Promise<void>
  connectionAbort: AbortController
}

/**
 * Connects a ws socket to the shared event runner.
 *
 * @param options - Accepted socket, connection scope, cancellation, and release operation.
 * @returns The runner, which retains callback work until its done promise settles.
 */
function wrapNodeWebSocket(options: NodeWebSocketOptions): WebSocketConnectionRunner {
  const { ws, handlers, connectionScope, lifecycle, release, connectionAbort } = options
  const transport: PlatformSocketTransport = {
    send(data) {
      ws.send(data)
    },
    close(code, reason) {
      ws.close(code, reason)
    },
    terminate() {
      ws.terminate()
    },
    get readyState() {
      return ws.readyState
    },
  }

  const runner = createWebSocketConnectionRunner({
    transport,
    handlers,
    connectionScope,
    lifecycle,
    release,
    connectionAbort,
  })

  ws.on('message', (raw: RawData, isBinary: boolean) => {
    const bytes = Array.isArray(raw)
      ? Buffer.concat(raw)
      : Buffer.isBuffer(raw)
        ? raw
        : Buffer.from(raw)
    runner.dispatchMessage(
      isBinary
        ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        : bytes.toString('utf8'),
    )
  })

  ws.on('close', (code: number, reason: Buffer) => {
    void runner.dispatchClose(code, reason.toString('utf-8'))
  })

  ws.on('error', (err: unknown) => {
    runner.dispatchError(err)
  })

  return runner
}

/** Interface for the unified Node WebSocket bridge. */
export interface NodeWebSocketBridge {
  /** Resolves to false when the upgrade belongs to another route or development host. */
  handleUpgrade(incoming: http.IncomingMessage, socket: Duplex, head: Buffer): Promise<boolean>
  /**
   * Drains pending handshakes and active connections.
   *
   * @param deadline - Absolute performance.now() deadline for forced transport termination.
   * @returns Resolves after handshake and callback work finishes; the host bounds its own wait.
   */
  close(deadline?: number): Promise<void>
}

/**
 * Creates the per-application bridge shared by Node production and Vite development.
 *
 * @param instance - Initialized Node application owning the routes and lifecycle.
 * @returns An upgrade handler and drain operation; the host enforces its shutdown budget.
 */
export function createNodeWebSocketBridge(instance: AppInstance<any>): NodeWebSocketBridge {
  const wss = new WebSocketServer({ noServer: true })
  const lifecycle = applicationLifecycles.get(instance)
  const activeConnections = new Set<WebSocketConnectionRunner>()
  const pendingHandshakes = new Set<{
    abort: AbortController
    done: Promise<void>
    socket: Duplex
  }>()
  const pendingUpgradeHeaders = new WeakMap<http.IncomingMessage, Response>()

  wss.on('headers', (resHeaders: string[], req: http.IncomingMessage) => {
    const response = pendingUpgradeHeaders.get(req)
    if (!response) return
    response.headers.forEach((val, key) => {
      const lower = key.toLowerCase()
      if (lower === 'upgrade' || lower === 'connection' || lower.startsWith('sec-websocket-')) {
        return
      }
      resHeaders.push(`${key}: ${val}`)
    })
  })

  const routes = (instance.definition.routes as readonly RouteEntry[]).toSorted((a, b) =>
    compareRoutes(a.routePath, b.routePath),
  )
  const resolvePath = createRequestPathResolver(routes, () => instance.config)
  const wsRouter = new TrieRouter<RouteEntry>()
  for (const entry of routes) {
    if (entry.routePath.isWs) {
      wsRouter.add('GET', entry.routePath.urlPath, entry)
    }
  }

  let closing = false

  async function handleUpgrade(
    incoming: http.IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<boolean> {
    const handshakeAbort = new AbortController()
    const request = incomingToRequest(incoming, handshakeAbort.signal)
    if (wsRouter.match('GET', resolvePath(request))[0].length === 0) {
      return false
    }

    if (closing || lifecycle?.drainingSignal.aborted) {
      await writeServerResponse(
        incoming,
        socket,
        new Response('Service Unavailable: Server is shutting down', { status: 503 }),
      )
      return true
    }

    const handshakeDone = Promise.withResolvers<void>()
    const handshakeEntry = { abort: handshakeAbort, done: handshakeDone.promise, socket }
    pendingHandshakes.add(handshakeEntry)

    const onSocketClose = () => {
      handshakeAbort.abort()
    }
    socket.once('close', onSocketClose)

    try {
      let response: Response
      try {
        response = await instance.fetch(request, { incoming })
      } catch (error) {
        response = formatErrorResponse(error, instance.config.production)
      }

      const upgradeState = getWsUpgradeState(response)
      if (closing || handshakeAbort.signal.aborted) {
        if (upgradeState) {
          upgradeState.complete?.(
            socket.destroyed ? undefined : 503,
            socket.destroyed ? 'aborted' : 'error',
          )
          upgradeState.connectionAbort.abort(handshakeAbort.signal.reason)
          await upgradeState.release!()
        }
        if (!socket.destroyed && socket.writable) {
          await writeServerResponse(
            incoming,
            socket,
            new Response('Service Unavailable: Server is shutting down', { status: 503 }),
          )
        }
        return true
      }

      if (upgradeState) {
        pendingUpgradeHeaders.set(incoming, response)
        let upgraded = false
        try {
          wss.handleUpgrade(incoming, socket, head, (ws: WebSocket) => {
            upgraded = true
            upgradeState.complete?.(101, 'ok')
            const conn = wrapNodeWebSocket({
              ws,
              handlers: upgradeState.handlers,
              connectionScope: upgradeState.scope,
              lifecycle,
              release: upgradeState.release!,
              connectionAbort: upgradeState.connectionAbort,
            })
            activeConnections.add(conn)
            conn.onDone(() => {
              activeConnections.delete(conn)
            })
            conn.start()
          })
        } finally {
          pendingUpgradeHeaders.delete(incoming)
          if (!upgraded) {
            upgradeState.complete?.(undefined, 'error')
            upgradeState.connectionAbort.abort()
            await upgradeState.release!()
          }
        }
      } else {
        await writeServerResponse(incoming, socket, response)
      }

      return true
    } finally {
      socket.removeListener('close', onSocketClose)
      pendingHandshakes.delete(handshakeEntry)
      handshakeDone.resolve()
    }
  }

  let closePromise: Promise<void> | undefined
  function close(deadline?: number): Promise<void> {
    if (closePromise) return closePromise
    closing = true

    // Pending handlers retain ownership of their response and release operation.
    for (const handshake of pendingHandshakes) {
      handshake.abort.abort()
    }

    const handshakePromises = [...pendingHandshakes].map((h) => h.done)
    const connPromises = [...activeConnections].map((conn) => conn.done())

    for (const conn of activeConnections) {
      conn.close(1001, 'Going Away')
    }

    let closeTimer: NodeJS.Timeout | undefined
    if (deadline !== undefined) {
      const remainingMs = Math.max(0, deadline - performance.now())
      closeTimer = setTimeout(() => {
        for (const h of pendingHandshakes) {
          h.socket.destroy()
        }
        for (const conn of activeConnections) {
          conn.terminate?.()
        }
      }, remainingMs)
      closeTimer.unref()
    }

    closePromise = Promise.all([
      ...handshakePromises,
      ...connPromises,
      new Promise<void>((resolve) => {
        wss.close(() => resolve())
      }),
    ]).then(() => {
      if (closeTimer) clearTimeout(closeTimer)
    })
    return closePromise
  }

  return {
    handleUpgrade,
    close,
  }
}
