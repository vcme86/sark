/**
 * Server-Sent Events (SSE) stream execution, heartbeats, and lifecycle coordination.
 *
 * @module
 */

import { getCurrentScope, type RequestScope, runInScope } from '../context'
import { applicationLifecycles } from '../lifecycle'
import { getLogger } from '../logging'
import type { AppInstance } from '../types'
import type { HttpContext, RouteEntry } from './assembly'
import type { SseDeclaration, SseHandlers, SseStream } from './types'

/**
 * Validates message metadata and encodes one SSE event block.
 *
 * @param event - Event type, without CR or LF.
 * @param data - Serialized JSON payload, split into data fields at line boundaries.
 * @param id - Optional reconnection ID, without CR, LF, or NUL.
 * @param retry - Optional non-negative integer retry interval in milliseconds.
 * @returns An event block terminated by a blank line.
 * @throws {Error} If the message metadata cannot be encoded as an SSE field.
 */
function encodeSseEvent(event: string, data: string, id?: string, retry?: number): string {
  if (/[\r\n]/.test(event)) {
    throw new Error('SSE event name cannot contain CR or LF characters.')
  }
  if (id !== undefined && /[\r\n\0]/.test(id)) {
    throw new Error('SSE id cannot contain CR, LF, or NUL characters.')
  }
  if (retry !== undefined && (!Number.isInteger(retry) || retry < 0)) {
    throw new Error('SSE retry interval must be a non-negative integer.')
  }
  const dataLines = data
    .split(/\r\n|\r|\n/)
    .map((line) => `data: ${line}`)
    .join('\n')
  const lines: string[] = []
  if (event) lines.push(`event: ${event}`)
  lines.push(dataLines)
  if (id !== undefined) lines.push(`id: ${id}`)
  if (retry !== undefined) lines.push(`retry: ${retry}`)
  return lines.join('\n') + '\n\n'
}

/**
 * Executes a Server-Sent Events endpoint over HTTP GET or handles HEAD admission.
 *
 * @param entry - The matched SSE route entry.
 * @param ctx - Context with the connection controller prepared before service binding.
 * @param handlersOrResponse - Endpoint result: an HTTP rejection or streaming callbacks.
 * @param instanceProvider - Optional provider returning the active application instance.
 * @returns A streaming Response with text/event-stream headers, or the admission Response.
 */
export async function executeSseEndpoint(
  entry: RouteEntry,
  ctx: HttpContext,
  handlersOrResponse: SseHandlers<any> | Response,
  instanceProvider?: () => AppInstance | undefined,
): Promise<Response> {
  if (handlersOrResponse instanceof Response) {
    return handlersOrResponse
  }

  if (ctx.req.method === 'HEAD') {
    ctx.header('Content-Type', 'text/event-stream; charset=utf-8')
    ctx.header('Cache-Control', 'no-cache')
    return ctx.body(null, 200)
  }

  if (entry.kind === 'page') {
    throw new Error('Cannot execute SSE on page route')
  }

  const sseDeclaration = entry.declaration as SseDeclaration<any, any, any>
  const sseHandlers = handlersOrResponse
  const instance = instanceProvider?.()
  const lifecycle = instance ? applicationLifecycles.get(instance) : undefined
  const connectionScope = getCurrentScope() as RequestScope
  const abortController = ctx.get('sark_connection_abort')
  const streamSignal = abortController.signal
  const executionCtx = connectionScope.executionCtx as
    | { waitUntil(work: Promise<unknown>): void }
    | undefined
  lifecycle?.beginRequest()

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>(undefined, undefined, {
    highWaterMark: 1,
  })
  const writer = writable.getWriter()
  const reader = readable.getReader()
  const encoder = new TextEncoder()
  const tasks = new Set<Promise<void>>()
  const cleanupListeners: Array<() => void> = []
  let closing = false
  let forceAborted = false
  let responseCancelled = false
  let pendingWrites = 0
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined
  let closePromise: Promise<void> | undefined

  function track(task: Promise<void>): void {
    tasks.add(task)
    void task.then(
      () => tasks.delete(task),
      () => tasks.delete(task),
    )
    executionCtx?.waitUntil(task)
  }

  async function dispatchError(error: unknown): Promise<void> {
    await runInScope(connectionScope, async () => {
      try {
        if (sseHandlers.onError) await sseHandlers.onError(stream, error)
        else getLogger().error('Unhandled error in SSE stream: {error}', { error })
      } catch (handlerError) {
        getLogger().error('Error in SSE onError handler: {error}', { error: handlerError })
      }
    })
  }

  /**
   * Initiates closing or upgrades an existing close to forced cancellation.
   *
   * Close order:
   * 1. Stop admission to writes and heartbeats, then notify the producer.
   * 2. On force cancellation, interrupt the reader/writer backpressure wait.
   * 3. Await returned producer work, onClose, and transport completion before releasing the count.
   *
   * @param forced - Whether buffered output may be discarded to end the transport.
   * @param reason - Cancellation reason inherited from the request or host.
   * @returns The shared close completion, which must not be awaited by its own producer.
   */
  function closeStream(forced = false, reason?: unknown): Promise<void> {
    closing = true
    abortController.abort(reason)
    if (heartbeatTimer !== undefined) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = undefined
    }
    if (forced && !forceAborted) {
      forceAborted = true
      void reader.cancel(streamSignal.reason).catch(() => {})
      void writer.abort(streamSignal.reason).catch(() => {})
    }
    if (!closePromise) {
      closePromise = (async () => {
        while (tasks.size > 0) await Promise.allSettled(tasks)
        await runInScope(connectionScope, async () => {
          try {
            await sseHandlers.onClose?.(stream)
          } catch (error) {
            getLogger().error('Error in SSE onClose handler: {error}', { error })
          }
        })
        if (!forceAborted) {
          try {
            await writer.close()
          } catch (error) {
            if (!forceAborted) throw error
          }
        }
      })().finally(() => {
        for (const cleanup of cleanupListeners) cleanup()
        lifecycle?.endRequest()
      })
      executionCtx?.waitUntil(closePromise)
    }
    return closePromise
  }

  const stream: SseStream<any> = {
    signal: streamSignal,
    async send(event, data, options) {
      if (closing || streamSignal.aborted) return
      const json = JSON.stringify(data)
      if (json === undefined) throw new TypeError('SSE data cannot be serialized to JSON.')
      const payload = encodeSseEvent(event, json, options?.id, options?.retry)
      pendingWrites++
      try {
        await writer.write(encoder.encode(payload))
      } catch (error) {
        if (forceAborted) return
        void closeStream(true)
        throw error
      } finally {
        pendingWrites--
      }
    },
    close() {
      void closeStream()
    },
  }

  const responseStream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (responseCancelled) return
        if (done) {
          await closeStream(forceAborted)
          if (!responseCancelled) controller.close()
        } else controller.enqueue(value)
      } catch (error) {
        await closeStream(true)
        if (!responseCancelled) controller.error(error)
      }
    },
    async cancel(reason) {
      responseCancelled = true
      await closeStream(true, reason)
    },
  })
  ctx.set('sark_sse_close', () => closeStream(true))

  function subscribe(signal: AbortSignal, handler: () => void): void {
    signal.addEventListener('abort', handler, { once: true })
    cleanupListeners.push(() => signal.removeEventListener('abort', handler))
  }
  subscribe(ctx.req.raw.signal, () => {
    void closeStream(true, ctx.req.raw.signal.reason)
  })
  if (lifecycle) {
    subscribe(lifecycle.drainingSignal, () => {
      void closeStream()
    })
    subscribe(lifecycle.signal, () => {
      void closeStream(true, lifecycle.signal.reason)
    })
  }

  const heartbeat = sseDeclaration.sseOptions.heartbeat
  if (heartbeat !== false) {
    heartbeatTimer = setInterval(() => {
      if (closing || pendingWrites > 0 || (writer.desiredSize !== null && writer.desiredSize <= 0))
        return
      const work = (async () => {
        pendingWrites++
        try {
          await writer.write(encoder.encode(': heartbeat\n\n'))
        } catch (error) {
          if (!forceAborted) {
            await dispatchError(error)
            void closeStream(true)
          }
        } finally {
          pendingWrites--
        }
      })()
      track(work)
    }, heartbeat)
  }

  if (streamSignal.aborted) void closeStream(true, streamSignal.reason)
  else if (sseHandlers.onOpen) {
    // Register before invoking onOpen: it may synchronously request its own close.
    track(
      Promise.resolve().then(async () => {
        try {
          await runInScope(connectionScope, () => sseHandlers.onOpen!(stream))
        } catch (error) {
          if (error !== streamSignal.reason) await dispatchError(error)
          void closeStream(true)
        }
      }),
    )
  }

  ctx.header('Content-Type', 'text/event-stream; charset=utf-8')
  ctx.header('Cache-Control', 'no-cache')
  return ctx.newResponse(responseStream)
}
