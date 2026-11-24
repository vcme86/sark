/**
 * Handler response formatting, JSON negotiation, and Set-Cookie preservation.
 *
 * @module
 */

import type { Context, MiddlewareHandler } from 'hono'
import { HTTPException } from 'hono/http-exception'
import Negotiator from 'negotiator'

import { HttpError } from '../../http/error'
import { getLogger } from '../logging'

const JSON_MEDIA_TYPES = ['application/json']
const textEncoder = new TextEncoder()
const REPRESENTATION_HEADERS = [
  'accept-ranges',
  'content-digest',
  'content-disposition',
  'content-encoding',
  'content-language',
  'content-length',
  'content-location',
  'content-range',
  'etag',
  'last-modified',
  'repr-digest',
  'trailer',
  'transfer-encoding',
]

/**
 * Formats expected HTTP failures and logs unexpected request errors.
 *
 * @param error - Failure raised during configuration or request execution.
 * @param production - Resolved host mode controlling unexpected-error details.
 * @returns The HTTP error response; unexpected-error details are included only in development.
 */
export function formatErrorResponse(error: unknown, production: boolean): Response {
  if (error instanceof HttpError) return error.toResponse()
  if (error instanceof HTTPException) return error.getResponse()

  getLogger().error(
    error instanceof Error ? `Request failed: ${error.message}` : 'Request failed',
    { error },
  )
  const isDev = !production
  return new HttpError(
    500,
    isDev && error instanceof Error ? error.message : 'Internal Server Error',
    {
      code: 'internal_server_error',
      details: isDev && error instanceof Error ? error.stack : undefined,
    },
  ).toResponse()
}

/**
 * Retains pending context headers and combines response cookies before Hono assignment.
 * Reading ctx.res materializes pending headers; otherwise native error Responses can lose them.
 * Hono replaces incoming cookies when context cookies exist, so combine them in the context first.
 *
 * @param ctx - Active Hono context.
 * @param response - Response object carrying headers to preserve.
 * @returns The original response instance.
 */
export function preserveResponseCookies(ctx: Context, response: Response): Response {
  const existing = ctx.res.headers.getSetCookie()
  const incoming = response.headers.getSetCookie()
  if (incoming.length === 0) return response
  if (existing.length === 0) return response

  const known = new Set(existing)
  for (const cookie of incoming) {
    if (!known.has(cookie)) ctx.header('Set-Cookie', cookie, { append: true })
  }
  return response
}

/**
 * Prepares a middleware or error response for Hono assignment.
 *
 * @param ctx - Active Hono context.
 * @param response - Response selected for delivery.
 * @returns The response to assign, with cookies and Vary fields retained.
 */
export function prepareResponse(ctx: Context, response: Response): Response {
  if (!ctx.finalized) {
    const vary = response.headers.get('Vary')
    if (vary) mergeVary(ctx.res.headers, vary)
    return preserveResponseCookies(ctx, response)
  }

  const previous = ctx.res
  if (previous === response) return response
  const headers = new Headers(previous.headers)
  headers.delete('content-type')
  // A HEAD response and a replacement 204 can both have a null body.
  if (
    previous.body !== response.body ||
    (response.body === null && previous.status !== response.status)
  ) {
    for (const name of REPRESENTATION_HEADERS) headers.delete(name)
  }
  for (const [name, value] of response.headers) {
    if (name === 'vary') mergeVary(headers, value)
    else if (name !== 'set-cookie') headers.set(name, value)
  }
  const cookies = new Set([...previous.headers.getSetCookie(), ...response.headers.getSetCookie()])
  headers.delete('set-cookie')
  for (const cookie of cookies) headers.append('set-cookie', cookie)

  const replacement = new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
  // Hono's setter would otherwise copy the headers from the old response again.
  ctx.res = undefined
  return replacement
}

/** Applies response replacement rules to middleware that returns a Response. */
export function wrapMiddlewareResponse(middleware: MiddlewareHandler): MiddlewareHandler {
  return async (ctx, next) => {
    const response = await middleware(ctx, next)
    if (!(response instanceof Response) || response === ctx.res) return response
    ctx.res = prepareResponse(ctx, response)
    return ctx.res
  }
}

function mergeVary(headers: Headers, value: string): void {
  const existingVary = headers.get('Vary')
  if (!existingVary) {
    headers.set('Vary', value)
    return
  }
  const fields = new Map<string, string>()
  for (const part of `${existingVary},${value}`.split(',')) {
    const field = part.trim()
    if (field === '*') {
      headers.set('Vary', '*')
      return
    }
    if (field) fields.set(field.toLowerCase(), field)
  }
  headers.set('Vary', [...fields.values()].join(', '))
}

/**
 * Checks whether Accept permits application/json, including wildcard quality values.
 * A missing or empty header accepts JSON; specificity and quality follow Negotiator.
 *
 * @param acceptHeader - Raw HTTP `Accept` header string from the request.
 * @returns `true` if client accepts JSON; otherwise `false`.
 */
export function acceptsJson(acceptHeader: string | null | undefined): boolean {
  if (!acceptHeader || acceptHeader.trim() === '') {
    return true
  }

  return Boolean(new Negotiator({ headers: { accept: acceptHeader } }).mediaType(JSON_MEDIA_TYPES))
}

/**
 * Formats a route handler's return value as an HTTP response.
 *
 * Output rules:
 * - Explicit Response: preserves status and headers without automatic JSON negotiation.
 * - Undefined: returns HTTP 204 without a body.
 * - Other values, including strings and null: serialize as JSON with Vary: Accept.
 *   A request rejecting JSON receives HTTP 406; automatic values use application/json.
 * - HEAD: preserves the selected response status and headers while omitting the body.
 *
 * @param output - Raw return value from the route handler.
 * @param request - Original HTTP request object.
 * @param baseHeaders - Headers accumulated by middleware, copied for automatic JSON or 204 responses.
 *   Explicit Response values retain their own headers; the Hono pipeline merges context headers.
 * @returns Formatted HTTP response.
 * @throws {HttpError} 406 if content negotiation fails.
 * @throws {TypeError} If output cannot be JSON-serialized, such as a bigint or circular object.
 */
export function formatResponse(output: unknown, request: Request, baseHeaders?: Headers): Response {
  if (output instanceof Response) {
    if (request.method === 'HEAD') {
      return new Response(null, {
        status: output.status,
        statusText: output.statusText,
        headers: output.headers,
      })
    }
    return output
  }

  const headers = new Headers(baseHeaders)

  if (output === undefined) {
    return new Response(null, {
      status: 204,
      headers,
    })
  }

  if (!acceptsJson(request.headers.get('Accept'))) {
    mergeVary(headers, 'Accept')
    throw new HttpError(406, 'Not Acceptable: client does not accept application/json', {
      headers,
    })
  }

  headers.set('Content-Type', 'application/json; charset=utf-8')

  mergeVary(headers, 'Accept')

  const encoded = textEncoder.encode(JSON.stringify(output))
  headers.set('Content-Length', String(encoded.byteLength))

  if (request.method === 'HEAD') {
    return new Response(null, {
      status: 200,
      headers,
    })
  }

  return new Response(encoded, {
    status: 200,
    headers,
  })
}
