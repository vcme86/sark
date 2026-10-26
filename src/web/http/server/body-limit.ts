import type { MiddlewareHandler } from 'hono'

import { HttpError } from '../error'

/**
 * Checks a framed Content-Length before middleware, or counts unknown-length bytes as read.
 * The host enforces HTTP framing; streamed bodies retain backpressure and cancellation.
 *
 * @param maxSize - Effective byte limit resolved for the selected route.
 * @returns Request admission middleware; disabled limits do not construct this handler.
 * @throws {HttpError} 413 for an oversized declared length; unknown-length reads fail with 413.
 */
export function bodyLimit(maxSize: number): MiddlewareHandler {
  return async (ctx, next) => {
    const request = ctx.req.raw
    if (!request.body) return next()
    if (request.headers.has('content-length') && !request.headers.has('transfer-encoding')) {
      if (Number(request.headers.get('content-length')) > maxSize)
        throw new HttpError(413, 'Payload Too Large')
      return next()
    }

    let size = 0
    const counter = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        size += chunk.byteLength
        if (size > maxSize) {
          controller.error(new HttpError(413, 'Payload Too Large'))
          return
        }
        controller.enqueue(chunk)
      },
    })
    ctx.req.raw = new Request(request, {
      body: request.body.pipeThrough(counter),
      duplex: 'half',
    } as RequestInit)
    return next()
  }
}
