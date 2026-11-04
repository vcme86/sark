/**
 * AsyncLocalStorage scopes for request identity, cancellation, deduplication, and cookies.
 *
 * @module
 */

import { AsyncLocalStorage } from 'node:async_hooks'

import type { Hono } from 'hono'

import type { ResolvedHttpConfig } from './config'
import type { RouteAdmission } from './http/assembly'
import type { ServiceBinding, ServiceBindingFactory } from './service'
import type { AppInstance } from './types'

/** Execution scope metadata associated with an asynchronous call tree. */
export interface ExecutionScope {
  /** Request identifier shared by the root request and its internal calls. */
  readonly requestId: string
  /** Original request identity retained when middleware replaces the body stream. */
  readonly request?: Request
  /** Reference to the Sark application instance executing this scope. */
  readonly app?: AppInstance<any>
  /** Cancellation signal inherited by internal requests and asynchronous work. */
  readonly signal?: AbortSignal
  /** Whether this request was dispatched internally by the same application. */
  readonly isInternal?: boolean
  /** Collects cookies returned by internal requests into the outer response. */
  readonly appendCookies?: (cookies: readonly string[]) => void
  /** Marks streamed response headers as committed before rendering continues. */
  readonly commitResponseHeaders?: () => Promise<void> | void
  /** Request-scoped cache shared by `dedup` wrappers. */
  readonly dedupStore?: Map<symbol, unknown>
  /** Resolved HTTP configuration in effect for this execution context. */
  readonly config?: ResolvedHttpConfig
  /** Client IP resolved from host metadata and trusted proxy forwarding. */
  readonly clientIp?: string
  /** Resolved external origin URL representing the public-facing application endpoint. */
  readonly externalOrigin?: string
  /** Environment bindings passed to current execution event. */
  readonly env?: unknown
  /** Platform execution context (e.g. Cloudflare Workers ExecutionContext). */
  readonly executionCtx?: unknown
  /** Resolved page configuration for fullstack page rendering. */
  readonly pageConfig?: unknown
  /** Assembled resources active for this execution scope. */
  readonly resources?: Readonly<Record<string, unknown>>
  /** Assembled domain services active for this execution scope. */
  readonly services?: Readonly<Record<string, unknown>>
  /** Active request lifecycle service bindings. */
  readonly serviceBindings?: Readonly<Record<string, ServiceBinding>>
  /** Factories producing per-request service bindings. */
  readonly serviceBindingFactories?: Readonly<Record<string, ServiceBindingFactory>>
  /** Prepared optional ingress policy reused throughout this execution. */
  readonly admission?: RouteAdmission
  /** Compiled HTTP graph reused by internal calls of this event. */
  readonly httpApp?: Hono<any>
  /** Observes the outer response's header commit boundary. */
  readonly isHeadersCommitted?: () => boolean
}

/** HTTP state established by request middleware before dispatching business or page handlers. */
export interface RequestScope extends ExecutionScope {
  readonly request: Request
  readonly signal: AbortSignal
  readonly config: ResolvedHttpConfig
  readonly clientIp: string
  readonly externalOrigin: string
  readonly serviceBindings: Record<string, ServiceBinding>
  readonly parentBindings?: Readonly<Record<string, ServiceBinding>>
  readonly isHeadersCommitted: () => boolean
  readonly appendCookies: NonNullable<ExecutionScope['appendCookies']>
  readonly commitResponseHeaders: NonNullable<ExecutionScope['commitResponseHeaders']>
}

const storage = new AsyncLocalStorage<ExecutionScope>()

/** Static route tables retained for internal Node host inspection without exposing the router. */
export const applicationRoutes = new WeakMap<object, Readonly<Hono['routes']>>()

/**
 * Reads a static application's compiled routes for host dispatch and conflict checks.
 *
 * @param instance - Created Node application whose routing metadata is registered.
 * @returns The existing Hono route table, without copying or rebuilding it.
 * @throws If the instance has no static host route table.
 */
export function getApplicationRoutes(instance: object): Readonly<Hono['routes']> {
  const routes = applicationRoutes.get(instance)
  if (!routes) throw new Error('Route inspection requires a static application instance.')
  return routes
}

/**
 * Runs a callback and its asynchronous work within the supplied scope.
 *
 * @param scope - The execution context to bind to the asynchronous call chain.
 * @param fn - Synchronous or asynchronous operation to execute.
 * @returns The return value of the callback.
 */
export function runInScope<R>(scope: ExecutionScope, fn: () => R): R {
  return storage.run(scope, fn)
}

/**
 * Runs without inheriting the caller's request scope, including its ID and dedup cache.
 * This only isolates context; it does not manage the callback's lifetime.
 *
 * @param fn - Operation to execute detached from the ambient context.
 * @returns The return value of the callback.
 */
export function runWithoutScope<R>(fn: () => R): R {
  return storage.exit(fn)
}

/**
 * Returns the active scope, or `undefined` outside scoped execution.
 *
 * @returns The active execution scope, or `undefined` if running outside an active scope.
 */
export function getCurrentScope(): ExecutionScope | undefined {
  return storage.getStore()
}

/**
 * Returns the active request ID, or `undefined` outside scoped execution.
 *
 * @returns The current request ID, or `undefined` outside a request scope.
 */
export function getRequestId(): string | undefined {
  return storage.getStore()?.requestId
}
