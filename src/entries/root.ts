/**
 * Server-side application declarations, HTTP routes, and request-scoped helpers.
 *
 * @module
 */

export { defineApp, type AppConfig, type AppDeclaration } from '../app/config'
export { createApp } from '../app/create'
export type { AppInstance, Register } from '../app/types'

export { route } from '../app/http/route'
export { z } from '../app/http/schema'
export { SOCKET_READY_STATE } from '../app/http/websocket'
export type {
  ClientInputFromSchemas,
  Context,
  EndpointFromRoute,
  InferRouteInput,
  InferSchemaInput,
  InferSchemaOutput,
  MiddlewareHandler,
  RouteDeclaration,
  RouteHandler,
  RouteInputSchema,
  RouteOptions,
  Socket,
  SocketHandlers,
  SseDeclaration,
  SseEndpointFromRoute,
  SseHandlers,
  SseOptions,
  SseSendOptions,
  SseStream,
  WsEndpointFromRoute,
} from '../app/http/types'
export type { Endpoint, HttpMethod, Jsonify } from '../http/types'

export { HttpError } from '../http/error'
export {
  deleteCookie,
  getCookie,
  getSignedCookie,
  setCookie,
  setSignedCookie,
} from '../app/http/cookie'

export { dedup } from '../app/dedup'
export { getLogger, type Logger } from '../app/logging'
