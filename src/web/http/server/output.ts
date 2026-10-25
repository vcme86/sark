/**
 * Handler response formatting, JSON negotiation, and Set-Cookie preservation.
 *
 * @module
 */

import type { Context, MiddlewareHandler } from 'hono'
import Negotiator from 'negotiator'

import { getLogger } from '../../../core/logging'
import { HttpError } from '../error'

const JSON_MEDIA_TYPES = ['application/json']
const textEncoder = new TextEncoder()

/**
 * Formats expected HTTP failures and logs unexpected request errors.
 *
 * @param error - Failure raised during configuration or request execution.
 * @param production - Resolved host mode controlling unexpected-error details.
 * @returns The HTTP error response; unexpected-error details are included only in development.
 */
export function formatErrorResponse(error: unknown, production: boolean): Response {
  if (error instanceof HttpError) return error.toResponse()

  getLogger().error('Request failed', { error })
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
 * Copies response cookies into a context that already has pending cookies.
 * Hono otherwise replaces the incoming Set-Cookie fields with the context's fields.
 * Returns the response unchanged; Hono performs the final assignment.
 *
 * @param ctx - Active Hono context.
 * @param response - Response object carrying headers to preserve.
 * @returns The original response instance.
 */
export function preserveResponseCookies(ctx: Context, response: Response): Response {
  const incoming = response.headers.getSetCookie()
  if (incoming.length === 0) return response
  const existing = ctx.res.headers.getSetCookie()
  if (existing.length === 0) return response

  const known = new Set(existing)
  for (const cookie of incoming) {
    if (!known.has(cookie)) ctx.header('Set-Cookie', cookie, { append: true })
  }
  return response
}

/**
 * Preserves cookies from early middleware responses before Hono assigns them.
 *
 * @param middleware - Underlying Hono middleware handler.
 * @returns Wrapped middleware with cookie preservation.
 */
export function preserveMiddlewareCookies(middleware: MiddlewareHandler): MiddlewareHandler {
  return async (ctx, next) => {
    const response = await middleware(ctx, next)
    if (response instanceof Response && !ctx.finalized) preserveResponseCookies(ctx, response)
    return response
  }
}

function mergeVaryAccept(headers: Headers): void {
  const existingVary = headers.get('Vary')
  if (!existingVary) {
    headers.set('Vary', 'Accept')
    return
  }
  const tokens = existingVary.split(',').map((t) => t.trim().toLowerCase())
  if (!tokens.includes('*') && !tokens.includes('accept')) {
    headers.set('Vary', `${existingVary}, Accept`)
  }
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

  const negotiator = new Negotiator({
    headers: { accept: acceptHeader },
  })

  return Boolean(negotiator.mediaType(JSON_MEDIA_TYPES))
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

  const accept = request.headers.get('Accept')
  if (!acceptsJson(accept)) {
    mergeVaryAccept(headers)
    throw new HttpError(406, 'Not Acceptable: client does not accept application/json', {
      headers,
    })
  }

  headers.set('Content-Type', 'application/json; charset=utf-8')

  mergeVaryAccept(headers)

  const jsonStr = JSON.stringify(output)
  const encoded = textEncoder.encode(jsonStr)
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
