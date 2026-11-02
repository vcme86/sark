/** Contracts shared by HTTP assembly, domain endpoints, and page handlers. */
import type { Context } from 'hono'

import type { RequestScope } from '../../core/context'
import type { HttpClient } from '../client/client'
import type { ParsedRoutePath } from '../path'
import type { RouteDeclaration, RouteScope, SseDeclaration } from '../types'
import type { WsUpgradeState } from './websocket'

/** Private variables used during endpoint preparation and host handoff. */
export interface HttpEnv {
  Variables: {
    sark_connection_abort: AbortController
    sark_sse_close?: () => Promise<void>
    sark_ws_upgrade?: WsUpgradeState
  }
}

/** Internal context carrying connection preparation and upgrade state. */
export type HttpContext = Context<HttpEnv>

/** Page request handler installed by generated application assembly. */
export type PageRequestHandler = (
  context: Context,
  client: HttpClient<any>,
  scope: RequestScope,
  production: boolean,
) => Promise<Response>

/** Parsed route entry pairing URL path metadata with its runtime handler declaration. */
interface RouteEntryBase {
  /** Source module path included in assembly diagnostics when available. */
  readonly source?: string
  /** Parsed URL structure and HTTP method constraints. */
  readonly routePath: ParsedRoutePath
  /** Ordered chain of ancestor directory scopes applying to this route. */
  readonly scopes?: readonly RouteScope[]
}

/** HTTP API declaration or a page terminal, sharing the same Hono execution chain. */
export type RouteEntry = RouteEntryBase &
  (
    | { readonly kind?: 'api'; readonly declaration: RouteDeclaration | SseDeclaration }
    | { readonly kind: 'page'; readonly pageHandler: PageRequestHandler }
  )
