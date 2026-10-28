/**
 * Generic resource assembly contracts and type inference.
 *
 * @module
 */

/** Shared shutdown state supplied when a resource is released. */
export interface DisposalContext {
  /** Aborted on failed initialization or forced shutdown; normal disposal leaves it active. */
  readonly signal: AbortSignal
  /** Host shutdown deadline on the performance.now() clock, when bounded. */
  readonly deadline?: number
}

/** Resource value and its owned cleanup, registered immediately after creation. */
interface ResourceResult<T> {
  readonly value: T
  readonly dispose?: (context: DisposalContext) => Promise<void> | void
}

/** Resource assembly contract for static host creation and event-scoped binding. */
export interface ResourceAssembly<T = unknown> {
  /** Target execution platform requirement, if restricted. */
  readonly target?: 'node' | 'cloudflare'

  /**
   * Assembles an instance-level resource on static hosts (e.g. Node.js).
   *
   * @param env - Environment supplied at application creation.
   * @param context - Creation cancellation shared with the application's lifecycle.
   * @returns The resource value and optional owned cleanup, registered after creation succeeds.
   * @throws If creation fails; the resource must release anything acquired before returning a result.
   */
  createStatic?(env: unknown, context: { readonly signal: AbortSignal }): Promise<ResourceResult<T>>

  /**
   * Assembles an event-scoped resource on event hosts (e.g. Cloudflare Workers).
   *
   * @param env - Bindings supplied by the current external event.
   * @returns A resource reused by internal calls in this event; its lifetime is platform-owned.
   */
  createForEvent?(env: unknown): Promise<{ value: T }> | { value: T }

  /** Type carrier for compile-time resource inference. */
  readonly $infer?: T
}

/** Extracts the inferred resource type from a resource assembly or declaration. */
export type InferResource<R> = R extends ResourceAssembly<infer T> ? T : never
