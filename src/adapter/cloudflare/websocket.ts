/**
 * Cloudflare Workers native WebSocket integration using WebSocketPair.
 *
 * @module
 */

import type { WebSocket as WorkerWebSocket } from '@cloudflare/workers-types'

import type { RequestScope } from '../../core/context'
import type { LifecycleManager } from '../../core/lifecycle'
import {
  createWebSocketConnectionRunner,
  type PlatformSocketTransport,
} from '../../http/server/websocket'
import type { SocketHandlers } from '../../http/types'

/** Options configuring the Cloudflare Workers WebSocket connection runner. */
interface CloudflareWebSocketOptions {
  serverSocket: WorkerWebSocket
  handlers: SocketHandlers
  connectionScope: RequestScope
  lifecycle?: LifecycleManager
  release: () => Promise<void>
  executionCtx: { waitUntil(promise: Promise<unknown>): void }
  connectionAbort: AbortController
}

/**
 * Installs listeners and starts dispatch for an accepted Workers socket.
 * Returned callback promises are tracked through executionCtx.waitUntil.
 *
 * @param options - Accepted socket, connection scope, release operation, and event work tracker.
 */
export function runCloudflareWebSocket(options: CloudflareWebSocketOptions): void {
  const {
    serverSocket,
    handlers,
    connectionScope,
    lifecycle,
    release,
    executionCtx,
    connectionAbort,
  } = options

  const transport: PlatformSocketTransport = {
    send(data) {
      serverSocket.send(data)
    },
    close(code, reason) {
      serverSocket.close(code, reason)
    },
    get readyState() {
      return serverSocket.readyState
    },
  }

  const runner = createWebSocketConnectionRunner({
    transport,
    handlers,
    connectionScope,
    lifecycle,
    release,
    onAsyncWork: (promise) => executionCtx.waitUntil(promise),
    connectionAbort,
  })

  serverSocket.addEventListener('message', (event) => {
    runner.dispatchMessage(typeof event.data === 'string' ? event.data : new Uint8Array(event.data))
  })

  serverSocket.addEventListener('close', (event) => {
    executionCtx.waitUntil(runner.dispatchClose(event.code, event.reason))
  })

  serverSocket.addEventListener('error', (event) => {
    runner.dispatchError(event)
  })

  runner.start()
}
