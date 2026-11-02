/**
 * HTTP client APIs and shared endpoint types for browser and server consumers.
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
} from '../http/client/client'
export { HttpError } from '../http/error'
export type {
  ClientInputFromSchemas,
  Endpoint,
  EndpointFromRoute,
  HttpMethod,
  Jsonify,
  SseEndpointFromRoute,
  WsEndpointFromRoute,
} from '../http/types'
