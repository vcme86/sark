/** Native Node response completion, independent of handler and application lifetimes. */
import type { Http2Bindings, HttpBindings } from '@hono/node-server'

import { type DeliveryResult, requestDeliveries } from '../../app/http/delivery'

type Outgoing = (HttpBindings | Http2Bindings)['outgoing']
const deliveries = new WeakMap<Outgoing, Promise<DeliveryResult>>()

/**
 * Observes finish, premature close and transport failure exactly once.
 * A finished response has reached the operating system, not necessarily the client.
 *
 * @param response - Native outgoing response observed before dispatch begins.
 * @returns Shared completion metadata for all owners observing this response.
 */
export function trackNodeResponse(response: Outgoing): Promise<DeliveryResult> {
  let delivery = deliveries.get(response)
  if (delivery) return delivery
  const result = Promise.withResolvers<DeliveryResult>()
  const finish = () => complete(response.statusCode < 400 ? 'ok' : 'error')
  const close = () =>
    complete(response.writableFinished ? (response.statusCode < 400 ? 'ok' : 'error') : 'aborted')
  const error = () => complete('error')
  const complete = (outcome: DeliveryResult['outcome']) => {
    response.off('finish', finish)
    response.off('close', close)
    response.off('error', error)
    result.resolve({ outcome, status: response.headersSent ? response.statusCode : undefined })
  }
  response.once('finish', finish)
  response.once('close', close)
  response.once('error', error)
  if (response.writableFinished) finish()
  else if (response.destroyed) close()
  delivery = result.promise
  deliveries.set(response, delivery)
  return delivery
}

/** Attaches native completion before application or static dispatch begins. */
export function bindNodeDelivery(request: Request, env: HttpBindings | Http2Bindings): void {
  requestDeliveries.set(request, trackNodeResponse(env.outgoing))
}

/**
 * Waits for both handler settlement and native response completion.
 * A disconnected transport does not finish a handler that is still running.
 *
 * @param work - Handler work whose failure is handled by the dispatch boundary.
 * @param response - Native outgoing response tracked independently of that work.
 * @returns A promise that resolves after both settle, including failed work.
 */
export async function waitForNodeRequest(
  work: Promise<unknown>,
  response: Outgoing,
): Promise<void> {
  await Promise.allSettled([work, trackNodeResponse(response)])
}
