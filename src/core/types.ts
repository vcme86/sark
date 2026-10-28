import type { ResolvedHttpConfig } from '../http/config'
import type { DisposalContext, InferResource } from './resource'

/** Server-side global type registry augmented by build-time code generation. */
export interface Register {}

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
   * @param context - Shared cancellation state and optional host shutdown deadline.
   * @returns A promise for asynchronous cleanup, or void when cleanup finishes synchronously.
   * @throws If cleanup fails; the lifecycle collects the error and continues other disposers.
   */
  dispose(context: DisposalContext): Promise<void> | void
}

/** Base application instance interface common to all configurations. */
interface BaseAppInstance<D = unknown> {
  /** Definition used to create this instance. */
  readonly definition: D

  /** Resolved instance configuration; event hosts expose the current event configuration only within its scope. */
  readonly config: ResolvedHttpConfig

  /** Current lifecycle state of the application. */
  readonly state: LifecycleState

  /**
   * Dispatches an external request in a new execution scope.
   *
   * @param request - Incoming Fetch API request, including its cancellation signal.
   * @param env - Platform environment bindings (e.g. Cloudflare Workers bindings).
   * @param executionCtx - Platform execution context (e.g. Cloudflare ExecutionContext).
   * @returns The HTTP response, including framework-generated error responses.
   */
  fetch(request: Request, env?: unknown, executionCtx?: unknown): Promise<Response>

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

/** Inferred resource capabilities derived from application definition resources. */
type AppInstanceResources<D> = D extends { resources?: infer R }
  ? [NonNullable<R>] extends [never]
    ? {}
    : {
        readonly [K in keyof NonNullable<R>]: InferResource<NonNullable<R>[K]>
      }
  : {}

/** Inferred domain service capabilities derived from application definition services. */
type AppInstanceServices<D> = D extends { services?: infer S }
  ? {
      readonly [
        K in keyof NonNullable<S> as [import('./service').InferService<NonNullable<S>[K]>] extends [
          never,
        ]
          ? never
          : K
      ]: import('./service').InferService<NonNullable<S>[K]>
    }
  : {}

/** Sark application runtime instance returned by `createApp`. */
export type AppInstance<D = unknown> = BaseAppInstance<D> &
  AppInstanceResources<D> &
  AppInstanceServices<D>
