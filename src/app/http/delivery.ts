/** Final response delivery metadata shared with transport owners. */
import { AsyncLocalStorage } from 'node:async_hooks'

export interface DeliveryResult {
  readonly status?: number
  readonly outcome: 'ok' | 'error' | 'aborted'
}

/** Native hosts attach actual transport completion before dispatching the same Request. */
export const requestDeliveries = new WeakMap<Request, Promise<DeliveryResult>>()

/**
 * Observes response body completion while preserving async scope and backpressure.
 * This tracks body consumption; native hosts supply transport completion separately.
 *
 * @param response - Response whose body reader is transferred to the wrapper.
 * @param complete - Called once on body completion, failure, or settled cancellation.
 *   Streamed delivery awaits any cleanup promise it returns.
 * @returns The original bodyless response or a response with an observed body stream.
 */
export function trackResponseCompletion(
  response: Response,
  complete: (outcome: 'ok' | 'error' | 'aborted') => Promise<void> | void,
): Response {
  let finished = false
  let completion: Promise<void> | void
  const finish = AsyncLocalStorage.bind((outcome: 'ok' | 'error' | 'aborted') => {
    if (!finished) {
      finished = true
      completion = complete(outcome)
    }
    return completion
  })
  if (!response.body) {
    void finish(response.status < 400 ? 'ok' : 'error')
    return response
  }
  const reader = response.body.getReader()
  let cancelled = false
  const body = new ReadableStream<Uint8Array>(
    {
      pull: AsyncLocalStorage.bind(
        async (controller: ReadableStreamDefaultController<Uint8Array>) => {
          let chunk: ReadableStreamReadResult<Uint8Array>
          try {
            chunk = await reader.read()
          } catch (error) {
            if (cancelled) return
            reader.releaseLock()
            try {
              const work = finish('error')
              if (work) await work
            } finally {
              if (!cancelled) controller.error(error)
            }
            return
          }
          if (cancelled) return
          if (!chunk.done) {
            controller.enqueue(chunk.value)
            return
          }
          reader.releaseLock()
          const work = finish(response.status < 400 ? 'ok' : 'error')
          if (work) await work
          if (!cancelled) controller.close()
        },
      ),
      cancel: AsyncLocalStorage.bind(async (reason: unknown) => {
        cancelled = true
        if (finished) {
          await completion
          return
        }
        try {
          await reader.cancel(reason)
        } finally {
          reader.releaseLock()
          const work = finish('aborted')
          if (work) await work
        }
      }),
    },
    { highWaterMark: 0 },
  )
  return new Response(body, response)
}
