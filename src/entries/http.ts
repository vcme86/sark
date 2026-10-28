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
} from '../http/client/client'
export { HttpError } from '../http/error'
export type {
  ClientInputFromSchemas,
  Endpoint,
  EndpointFromRoute,
  HttpMethod,
  Jsonify,
} from '../http/types'
