/**
 * Client-side Server-Sent Events (SSE), JSON event dispatch, and reconnection.
 *
 * @module
 */

import { HttpError } from '../http/error'
import type { ClientCallOptions } from './client'
import { decodeResponse } from './decode'

/** Callback signature for typed SSE events. */
export type SseEventHandler<T = unknown> = (data: T) => void

/** Callback signature for connection-level errors (including initial HTTP errors). */
export type SseErrorHandler = (error: unknown) => void

/** Client handle for an active Server-Sent Events subscription. */
export interface SseConnection<TEvents = Record<string, unknown>> {
  /**
   * Registers a callback for a specific event name.
   *
   * @param event - Event type defined in the server's event table.
   * @param handler - Callback receiving the decoded JSON payload.
   * @returns Unsubscribe function.
   */
  on<E extends keyof TEvents & string>(event: E, handler: SseEventHandler<TEvents[E]>): () => void

  /**
   * Registers a callback for connection-level or protocol errors.
   *
   * @param handler - Callback receiving the error (e.g. HttpError on non-2xx).
   * @returns Unsubscribe function.
   */
  onError(handler: SseErrorHandler): () => void

  /** Permanently closes the connection and cancels reconnection. */
  close(): void
}

/** Options configuring the low-level SSE connection. */
interface SseConnectionOptions {
  fetch: (request: Request) => Promise<Response>
  prepareRequest: () => Promise<{ url: string; headers: Headers; credentials: RequestCredentials }>
  callOptions: ClientCallOptions
}

/**
 * Creates an SSE connection to a streaming endpoint.
 *
 * @param options - Resolved request preparation, transport, and per-call options.
 * @returns An active SseConnection instance.
 */
export function createSseConnection<TEvents>(
  options: SseConnectionOptions,
): SseConnection<TEvents> {
  const { callOptions } = options

  const eventListeners = new Map<string, Set<SseEventHandler<any>>>()
  const errorListeners = new Set<SseErrorHandler>()

  let closed = false
  let lastEventId: string | undefined
  let retryInterval = 3000
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let activeAbortController: AbortController | undefined
  let activeResponse: Response | undefined
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | undefined

  const terminate = () => {
    closed = true
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = undefined
    }
    activeAbortController?.abort()
    if (activeReader) {
      activeReader.cancel().catch(() => {})
    } else if (activeResponse?.body && !activeResponse.body.locked) {
      void activeResponse.body.cancel().catch(() => {})
    }
    callOptions.init?.signal?.removeEventListener('abort', terminate)
  }

  const dispatchEvent = (eventName: string, data: any) => {
    const handlers = eventListeners.get(eventName)
    if (handlers) {
      for (const handler of handlers) {
        if (closed) break
        try {
          handler(data)
        } catch (error) {
          dispatchError(error)
        }
      }
    }
  }

  const dispatchError = (err: unknown) => {
    for (const handler of errorListeners) {
      if (closed) break
      try {
        handler(err)
      } catch (error) {
        console.error('SSE error callback failed', error)
      }
    }
  }

  const scheduleReconnect = () => {
    if (closed || callOptions.init?.signal?.aborted) return
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined
      void connect()
    }, retryInterval)
  }

  const connect = async () => {
    if (closed || callOptions.init?.signal?.aborted) return

    activeAbortController = new AbortController()
    const signal = callOptions.init?.signal
      ? AbortSignal.any([callOptions.init.signal, activeAbortController.signal])
      : activeAbortController.signal

    let prepared: { url: string; headers: Headers; credentials: RequestCredentials }
    try {
      prepared = await options.prepareRequest()
    } catch (error) {
      if (closed || signal.aborted) return
      dispatchError(error)
      scheduleReconnect()
      return
    }

    if (closed || signal.aborted) return
    let req: Request
    try {
      const headers = prepared.headers
      headers.set('Accept', 'text/event-stream')
      if (lastEventId === '') headers.delete('Last-Event-ID')
      else if (lastEventId !== undefined) {
        // Fetch Headers accepts bytes; the SSE protocol encodes event IDs as UTF-8.
        headers.set(
          'Last-Event-ID',
          Array.from(new TextEncoder().encode(lastEventId), (byte) =>
            String.fromCharCode(byte),
          ).join(''),
        )
      }
      req = new Request(prepared.url, {
        ...callOptions.init,
        method: 'GET',
        headers,
        credentials: prepared.credentials,
        signal,
      })
    } catch (error) {
      dispatchError(error)
      terminate()
      return
    }

    let res: Response
    try {
      res = await options.fetch(req)
      if (closed || signal.aborted) {
        await res.body?.cancel()
        return
      }
      activeResponse = res
    } catch (error) {
      if (closed || signal.aborted) return
      dispatchError(error)
      scheduleReconnect()
      return
    }

    if (res.status === 204) {
      // 204 No Content tells client not to reconnect per SSE specification
      terminate()
      return
    }

    if (res.status !== 200) {
      try {
        if (res.ok)
          throw new HttpError(res.status, 'Expected HTTP 200 for an SSE stream', {
            code: 'invalid_status',
            headers: res.headers,
          })
        await decodeResponse(res)
      } catch (httpError) {
        dispatchError(httpError)
      }
      terminate()
      return
    }

    const rawContentType = res.headers.get('content-type') ?? ''
    const mimeType = rawContentType.split(';')[0].trim().toLowerCase()
    if (mimeType !== 'text/event-stream') {
      const err = new HttpError(res.status, 'Invalid content type: expected text/event-stream', {
        code: 'invalid_content_type',
        headers: res.headers,
      })
      dispatchError(err)
      terminate()
      return
    }

    if (!res.body) {
      scheduleReconnect()
      return
    }

    const reader = res.body.getReader()
    activeReader = reader
    const decoder = new TextDecoder('utf-8', { fatal: false })

    let lineParts: string[] = []
    let discardNextLf = false
    let eventType = ''
    let dataLines: string[] = []
    let idBuffer = lastEventId ?? ''

    const consumeLine = (line: string) => {
      if (line.length === 0) {
        // Only complete blocks commit IDs, including blocks without data.
        lastEventId = idBuffer
        if (dataLines.length > 0) {
          const eventName = eventType || 'message'
          const rawData = dataLines.join('\n')
          try {
            dispatchEvent(eventName, JSON.parse(rawData))
          } catch (error) {
            dispatchError(error)
          }
        }
        eventType = ''
        dataLines = []
        return
      }
      if (line.charCodeAt(0) === 58) return
      const colon = line.indexOf(':')
      const field = colon === -1 ? line : line.slice(0, colon)
      let value = colon === -1 ? '' : line.slice(colon + 1)
      if (value.charCodeAt(0) === 32) value = value.slice(1)
      if (field === 'event') eventType = value
      else if (field === 'data') dataLines.push(value)
      else if (field === 'id' && !value.includes('\u0000')) idBuffer = value
      else if (field === 'retry' && /^\d+$/.test(value)) retryInterval = Number.parseInt(value, 10)
    }

    try {
      while (true) {
        if (closed) return
        const { done, value } = await reader.read()
        if (done) break
        const chunk = decoder.decode(value, { stream: true })
        if (!chunk.length) continue
        let start = 0
        if (discardNextLf) {
          discardNextLf = false
          if (chunk.charCodeAt(0) === 10) start = 1
        }
        for (let index = start; index < chunk.length; index++) {
          const code = chunk.charCodeAt(index)
          if (code !== 10 && code !== 13) continue
          lineParts.push(chunk.slice(start, index))
          const line = lineParts.length === 1 ? lineParts[0] : lineParts.join('')
          lineParts = []
          consumeLine(line)
          if (closed) return
          if (code === 13) {
            if (index + 1 === chunk.length) discardNextLf = true
            else if (chunk.charCodeAt(index + 1) === 10) index++
          }
          start = index + 1
        }
        if (start < chunk.length) lineParts.push(chunk.slice(start))
      }
    } catch (error) {
      if (!closed && !signal.aborted) {
        dispatchError(error)
      }
    } finally {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
      activeReader = undefined
      activeResponse = undefined
    }

    if (!closed && !signal.aborted) {
      scheduleReconnect()
    }
  }

  const externalSignal = callOptions.init?.signal
  if (externalSignal?.aborted) terminate()
  else {
    externalSignal?.addEventListener('abort', terminate, { once: true })
    void connect()
  }

  return {
    on(event, handler) {
      let set = eventListeners.get(event)
      if (!set) {
        set = new Set()
        eventListeners.set(event, set)
      }
      set.add(handler)
      return () => {
        set?.delete(handler)
      }
    },
    onError(handler) {
      errorListeners.add(handler)
      return () => {
        errorListeners.delete(handler)
      }
    },
    close() {
      terminate()
    },
  }
}
