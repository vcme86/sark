/**
 * Server-side application declarations, HTTP routes, and request-scoped helpers.
 *
 * @module
 */

export { defineApp, type AppConfig, type AppDeclaration } from '../core/config'
export { createApp } from '../core/create'
export { dedup } from '../core/dedup'
export { getLogger, type Logger } from '../core/logging'
export type { AppInstance, Register } from '../core/types'
export {
  deleteCookie,
  getCookie,
  getSignedCookie,
  setCookie,
  setSignedCookie,
} from '../http/cookie'
export { HttpError } from '../http/error'
export { z } from '../http/schema'
export { route } from '../http/server/route'
export type {
  ClientInputFromSchemas,
  Context,
  Endpoint,
  EndpointFromRoute,
  HttpMethod,
  InferRouteInput,
  InferSchemaInput,
  InferSchemaOutput,
  Jsonify,
  MiddlewareHandler,
  RouteDeclaration,
  RouteHandler,
  RouteInputSchema,
  RouteOptions,
} from '../http/types'
