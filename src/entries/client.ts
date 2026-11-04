/**
 * HTTP clients, endpoint contracts, errors, and standalone Cookie utilities.
 *
 * @module
 */

export {
  createClient,
  type ClientCallOptions,
  type ClientOptions,
  type DefaultApi,
  type HttpClient,
  type Register,
  type SseConnection,
} from '../client/client'
export { HttpError } from '../http/error'
export type {
  ClientInputFromSchemas,
  EndpointFromRoute,
  SseEndpointFromRoute,
  WsEndpointFromRoute,
} from '../app/http/types'
export type { Endpoint, HttpMethod, Jsonify } from '../http/types'

export {
  parse as parseCookie,
  parseSigned as parseSignedCookie,
  serialize as serializeCookie,
  serializeSigned as serializeSignedCookie,
} from 'hono/utils/cookie'

export type { Cookie, CookieConstraint, CookieOptions, SignedCookie } from 'hono/utils/cookie'
