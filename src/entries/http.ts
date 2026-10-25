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
} from '../web/http/client/client'
export { HttpError } from '../web/http/error'
export type {
  ClientInputFromSchemas,
  Endpoint,
  EndpointFromRoute,
  HttpMethod,
  Jsonify,
} from '../web/http/types'
