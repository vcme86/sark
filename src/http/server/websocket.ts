/**
 * Shared WebSocket connection runner, admission checks, and lifecycle integration.
 *
 * @module
 */

import { AsyncLocalStorage } from 'node:async_hooks'

import { getCurrentScope, type RequestScope, runInScope } from '../../core/context'
import type { LifecycleManager } from '../../core/lifecycle'
import { getLogger } from '../../core/logging'
import { HttpError } from '../error'
import type { Socket, SocketHandlers } from '../types'
import type { HttpContext } from './types'

/** State captured during the HTTP upgrade pipeline before protocol switching. */
export interface WsUpgradeState {
  readonly handlers: SocketHandlers
  readonly scope: RequestScope
  /** Empty body whose identity survives response-header reconstruction. */
  readonly carrier: ReadableStream<Uint8Array>
  readonly connectionAbort: AbortController
  /** Assigned after pipeline acceptance; releases event services and the reservation once. */
  release?: () => Promise<void>
}

/** Registry mapping carrier streams to their upgrade state. */
export const wsUpgradeCarrierMap = new WeakMap<ReadableStream, WsUpgradeState>()

/** Returns the prepared upgrade while its marker body and acceptance status are retained. */
export function getWsUpgradeState(res: Response): WsUpgradeState | undefined {
  if (res.status !== 200 || !res.body) return undefined
  return wsUpgradeCarrierMap.get(res.body as ReadableStream)
}

/** Standard WebSocket numeric ready states per RFC 6455. */
export const SOCKET_READY_STATE = {
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3,
} as const

/**
 * Checks a WebSocket handshake against the resolved source policy.
 * Missing Origin is allowed for non-browser clients; Origin: null is rejected.
 *
 * @param ctx - Handshake context with the request's resolved external origin.
 * @param effectiveCsrf - Selected route policy, including any explicit origin allowlist.
 * @throws {HttpError} With status 403 and code csrf_forbidden when the source is rejected.
 */
function checkWebSocketOrigin(
  ctx: HttpContext,
  effectiveCsrf?: boolean | { origins?: string[] },
): void {
  if (effectiveCsrf === false) return
  const origin = ctx.req.header('origin')
  if (!origin) {
    return
  }
  if (origin === 'null') {
    throw new HttpError(403, 'Forbidden: null origin is rejected', { code: 'csrf_forbidden' })
  }
  const scope = getCurrentScope()
  const currentOrigin = scope?.externalOrigin || new URL(ctx.req.url).origin
  if (origin === currentOrigin) return
  const allowed =
    typeof effectiveCsrf === 'object' && Array.isArray(effectiveCsrf.origins)
      ? effectiveCsrf.origins
      : []
  if (allowed.includes(origin)) return

  throw new HttpError(403, 'Forbidden by CSRF protection', { code: 'csrf_forbidden' })
}

/**
 * Prepares an accepted upgrade or returns an ordinary HTTP rejection.
 *
 * @param ctx - Context with the connection controller prepared before service binding.
 * @param handlersOrResponse - Endpoint result: connection callbacks or an HTTP response.
 * @param effectiveCsrf - Resolved source policy for the selected endpoint.
 * @returns An HTTP rejection or a body-marked response for the platform's upgrade handoff.
 * The marked response does not itself complete a network handshake.
 */
export async function executeWebSocketEndpoint(
  ctx: HttpContext,
  handlersOrResponse: SocketHandlers | Response,
  effectiveCsrf?: boolean | { origins?: string[] },
): Promise<Response> {
  if (handlersOrResponse instanceof Response) {
    return handlersOrResponse
  }

  if (ctx.req.method !== 'GET') {
    return new Response('Method Not Allowed', {
      status: 405,
      headers: { Allow: 'GET' },
    })
  }

  const upgrade = ctx.req.header('upgrade')?.toLowerCase()
  if (upgrade !== 'websocket') {
    return new Response('Upgrade Required', {
      status: 426,
      headers: {
        Upgrade: 'websocket',
        Connection: 'Upgrade',
        'Content-Type': 'text/plain; charset=utf-8',
      },
    })
  }

  checkWebSocketOrigin(ctx, effectiveCsrf)

  const scope = getCurrentScope() as RequestScope | undefined
  if (!scope) {
    throw new Error('WebSocket endpoint executed outside of an established RequestScope.')
  }

  const connectionAbort = ctx.get('sark_connection_abort')

  const carrier = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close()
    },
  })

  const res = ctx.newResponse(carrier, 200)

  const upgradeState: WsUpgradeState = {
    // Platform callbacks run outside the handshake's async call tree.
    handlers: {
      onOpen: handlersOrResponse.onOpen && AsyncLocalStorage.bind(handlersOrResponse.onOpen),
      onMessage:
        handlersOrResponse.onMessage && AsyncLocalStorage.bind(handlersOrResponse.onMessage),
      onClose: handlersOrResponse.onClose && AsyncLocalStorage.bind(handlersOrResponse.onClose),
      onError: handlersOrResponse.onError && AsyncLocalStorage.bind(handlersOrResponse.onError),
    },
    scope,
    carrier,
    connectionAbort,
  }
  ctx.set('sark_ws_upgrade', upgradeState)
  wsUpgradeCarrierMap.set(carrier, upgradeState)

  return res
}

/** Underlying platform socket transport interface used by the shared connection runner. */
export interface PlatformSocketTransport {
  send(data: string | Uint8Array): void
  close(code?: number, reason?: string): void
  terminate?(): void
  readonly readyState: number
}

/** Coordinates scoped socket callbacks, asynchronous work, and connection release. */
export interface WebSocketConnectionRunner {
  readonly socket: Socket
  start(): void
  dispatchMessage(data: string | Uint8Array): void
  dispatchClose(code: number, reason: string): Promise<void>
  dispatchError(error: unknown): void
  close(code?: number, reason?: string): void
  terminate(): void
  onDone(cb: () => void): void
  done(): Promise<void>
}

/** Options configuring the shared WebSocket connection runner. */
interface WebSocketConnectionRunnerOptions {
  transport: PlatformSocketTransport
  handlers: SocketHandlers
  connectionScope: RequestScope
  connectionAbort: AbortController
  release: () => Promise<void>
  lifecycle?: LifecycleManager
  onAsyncWork?: (promise: Promise<unknown>) => void
}

/**
 * Adapts platform events to scoped application callbacks and owns the accepted connection release.
 *
 * @param options - Prepared transport, scope, cancellation, and release operation from the host.
 * @returns A runner whose done promise settles after returned callback work, onClose, and release.
 * Forced transport termination does not complete unfinished application promises.
 */
export function createWebSocketConnectionRunner(
  options: WebSocketConnectionRunnerOptions,
): WebSocketConnectionRunner {
  const { transport, handlers, connectionScope, connectionAbort, release, lifecycle, onAsyncWork } =
    options
  const donePromise = Promise.withResolvers<void>()
  const connectionSignal = connectionAbort.signal

  const inFlightTasks = new Set<Promise<void>>()
  const doneCallbacks: Array<() => void> = []
  const cleanupListeners: Array<() => void> = []

  let closed = false

  const socket: Socket = {
    send(data: string | Uint8Array) {
      if (closed || transport.readyState !== 1) return
      try {
        transport.send(data)
      } catch (error) {
        dispatchError(error)
      }
    },
    close(code?: number, reason?: string) {
      connectionAbort.abort()
      try {
        transport.close(code, reason)
      } catch (error) {
        dispatchError(error)
      }
    },
    get signal() {
      return connectionSignal
    },
    get readyState() {
      return transport.readyState
    },
  }

  function trackTask(task: Promise<void>): void {
    inFlightTasks.add(task)
    onAsyncWork?.(task)
    void task.then(
      () => inFlightTasks.delete(task),
      () => inFlightTasks.delete(task),
    )
  }

  const reportError = (error: unknown): Promise<void> =>
    runInScope(connectionScope, async () => {
      try {
        if (handlers.onError) await handlers.onError(socket, error)
        else getLogger().error('Unhandled WebSocket error: {error}', { error })
      } catch (handlerError) {
        getLogger().error('Error in WebSocket onError handler: {error}', { error: handlerError })
      }
    })

  const dispatchError = (error: unknown): void => {
    if (!closed) trackTask(reportError(error))
  }

  let closePromise: Promise<void> | undefined
  const finishClose = (code: number, reason: string): Promise<void> => {
    if (closePromise) return closePromise
    closePromise = (async () => {
      closed = true
      connectionAbort.abort()

      while (inFlightTasks.size > 0) {
        await Promise.allSettled(inFlightTasks)
      }

      if (handlers.onClose) {
        try {
          await runInScope(connectionScope, () => handlers.onClose!(socket, code, reason))
        } catch (error) {
          runInScope(connectionScope, () =>
            getLogger().error('Error in WebSocket onClose handler: {error}', { error }),
          )
        }
      }

      try {
        await release()
      } catch (error) {
        runInScope(connectionScope, () =>
          getLogger().error('Error in WebSocket release: {error}', { error }),
        )
      }
    })().finally(() => {
      for (const cleanup of cleanupListeners) cleanup()
      for (const callback of doneCallbacks) callback()
      donePromise.resolve()
    })
    return closePromise
  }

  // Draining requests the closing handshake; force cancellation terminates the transport.
  if (lifecycle?.drainingSignal) {
    const onDrain = () => {
      socket.close(1001, 'Going Away')
    }
    lifecycle.drainingSignal.addEventListener('abort', onDrain, { once: true })
    cleanupListeners.push(() => lifecycle.drainingSignal.removeEventListener('abort', onDrain))
  }

  if (lifecycle?.signal) {
    const onForceAbort = () => {
      connectionAbort.abort()
      transport.terminate?.()
      void finishClose(1006, 'Server shutting down')
    }
    lifecycle.signal.addEventListener('abort', onForceAbort, { once: true })
    cleanupListeners.push(() => lifecycle.signal.removeEventListener('abort', onForceAbort))
  }

  return {
    socket,
    start() {
      if (closed || connectionSignal.aborted) return
      if (handlers.onOpen) {
        try {
          const work = runInScope(connectionScope, () => handlers.onOpen!(socket))
          if (work && typeof work.then === 'function') {
            trackTask(work.catch(reportError))
          }
        } catch (error) {
          dispatchError(error)
        }
      }
    },
    dispatchMessage(data: string | Uint8Array) {
      if (closed || connectionSignal.aborted) return
      if (!handlers.onMessage) return

      try {
        const work = runInScope(connectionScope, () => handlers.onMessage!(socket, data))
        if (work && typeof work.then === 'function') {
          trackTask(work.catch(reportError))
        }
      } catch (error) {
        dispatchError(error)
      }
    },
    dispatchClose(code: number, reason: string) {
      return finishClose(code, reason)
    },
    dispatchError,
    close(code, reason) {
      socket.close(code, reason)
    },
    terminate() {
      connectionAbort.abort()
      transport.terminate?.()
    },
    onDone(cb) {
      doneCallbacks.push(cb)
    },
    done() {
      return donePromise.promise
    },
  }
}
