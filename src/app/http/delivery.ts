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
 * @returns The original bodyless response or a response with an observed body stream.
 */
export function trackResponseCompletion(
  response: Response,
  complete: (outcome: 'ok' | 'error' | 'aborted') => void,
): Response {
  let finished = false
  const finish = AsyncLocalStorage.bind((outcome: 'ok' | 'error' | 'aborted') => {
    if (finished) return
    finished = true
    complete(outcome)
  })
  if (!response.body) {
    finish(response.status < 400 ? 'ok' : 'error')
    return response
  }
  const reader = response.body.getReader()
  let cancelled = false
  const body = new ReadableStream<Uint8Array>(
    {
      pull: AsyncLocalStorage.bind(
        async (controller: ReadableStreamDefaultController<Uint8Array>) => {
          try {
            const chunk = await reader.read()
            if (cancelled) return
            if (chunk.done) {
              reader.releaseLock()
              finish(response.status < 400 ? 'ok' : 'error')
              controller.close()
            } else controller.enqueue(chunk.value)
          } catch (error) {
            if (cancelled) return
            reader.releaseLock()
            finish('error')
            controller.error(error)
          }
        },
      ),
      cancel: AsyncLocalStorage.bind(async (reason: unknown) => {
        cancelled = true
        try {
          await reader.cancel(reason)
        } finally {
          reader.releaseLock()
          finish('aborted')
        }
      }),
    },
    { highWaterMark: 0 },
  )
  return new Response(body, response)
}
