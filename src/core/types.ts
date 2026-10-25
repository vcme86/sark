import type { Hono } from 'hono'

import type { ResolvedHttpConfig } from '../web/http/config'

/**
 * Application lifecycle states:
 * - initializing: configuration and request pipeline setup are in progress.
 * - ready: the application accepts external requests; readiness responds HTTP 200.
 * - draining: new external requests are rejected; accepted handlers may finish internal calls.
 * - closed: resource disposal has finished, including disposal attempts that reported errors.
 */
export type LifecycleState = 'initializing' | 'ready' | 'draining' | 'closed'

/** Disposable resource interface registered during creation for automatic cleanup on shutdown. */
export interface DisposableResource {
  /** Diagnostic name of the resource (e.g. `'database'`, `'storage'`). */
  readonly name: string

  /**
   * Releases the resource during reverse-order shutdown or creation rollback.
   *
   * @returns A promise for asynchronous cleanup, or void when cleanup finishes synchronously.
   * @throws If cleanup fails; the lifecycle collects the error and continues other disposers.
   */
  dispose(): Promise<void> | void
}

/** Sark application runtime instance returned by `createApp`. */
export interface AppInstance<D = unknown> {
  /** Definition used to create this instance. */
  readonly definition: D

  /** Resolved application HTTP configuration. */
  readonly config: ResolvedHttpConfig

  /** Underlying Hono instance for advanced extension and inspection. */
  readonly hono: Hono<any>

  /** Current lifecycle state of the application. */
  readonly state: LifecycleState

  /**
   * Dispatches an external request in a new execution scope.
   *
   * @param request - Incoming Fetch API request, including its cancellation signal.
   * @param env - Request metadata supplied by the Node host.
   * @returns The HTTP response, including framework-generated error responses.
   */
  fetch(request: Request, env?: unknown): Promise<Response>

  /**
   * Dispatches an internal request using the current same-application scope.
   * Reuses request identity, cancellation and dedup state, and collects response cookies.
   * Without a matching parent scope, falls back to external dispatch.
   *
   * @param request - Internal API request with explicitly supplied headers and body.
   * @returns The internal HTTP response; this method does not decode it.
   */
  fetchInternal(request: Request): Promise<Response>

  /**
   * Stops external admission, waits for active handlers, and releases resources.
   * Repeated calls share the same shutdown operation. Node hosting also waits for
   * response streams within its configured deadline.
   *
   * @returns A promise resolving after shutdown and resource disposal complete.
   * @throws If waiting or disposal fails; multiple failures use AggregateError.
   */
  close(): Promise<void>
}
