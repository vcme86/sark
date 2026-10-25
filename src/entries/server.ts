/**
 * Server-side application declarations, HTTP routes, and request-scoped helpers.
 *
 * @module
 */

export { defineApp, type AppConfig, type AppDeclaration } from '../core/config'
export { createApp } from '../core/create'
export { dedup } from '../core/dedup'
export { getLogger, type Logger } from '../core/logging'
export type { AppInstance } from '../core/types'
export {
  deleteCookie,
  getCookie,
  getSignedCookie,
  setCookie,
  setSignedCookie,
} from '../web/http/cookie'
export { HttpError } from '../web/http/error'
export { z } from '../web/http/schema'
export { route } from '../web/http/server/route'
export type {
  ClientInputFromSchemas,
  Endpoint,
  EndpointFromRoute,
  HttpMethod,
  InferRouteInput,
  InferSchemaInput,
  InferSchemaOutput,
  Jsonify,
  RouteDeclaration,
  RouteHandler,
  RouteInputSchema,
  RouteOptions,
} from '../web/http/types'
