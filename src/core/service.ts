/** Internal contracts for generated domain assembly and request bindings. */
import type { Context } from 'hono'

import type { ResolvedHttpConfig } from '../http/config'
import type { RouteEntry } from '../http/server/types'

/** Request facilities shared with an optional domain. */
export interface RequestBindingContext {
  readonly ctx: Context
  readonly request: Request
  readonly signal: AbortSignal
  readonly parentBinding?: ServiceBinding
  readonly appendCookie: (cookie: string) => void
  readonly isHeadersCommitted: () => boolean
}

/** A domain's state and hooks for one request, inherited by internal calls. */
export interface ServiceBinding {
  readonly state?: unknown
  /** Only a verified credential may grant a CSRF exemption. */
  readonly csrfExempt?: boolean
  readonly onCommitHeaders?: () => Promise<void> | void
}

/** Creates a fully initialized request binding within the active request scope. */
export type ServiceBindingFactory = (
  context: RequestBindingContext,
) => ServiceBinding | Promise<ServiceBinding>

/** Domain facilities created after the application's resources are ready. */
export interface ServiceInstanceResult<TService = unknown> {
  readonly service?: TService
  readonly createBinding?: ServiceBindingFactory
}

/** Validated configuration and routes prepared before resources are created. */
export interface ServicePreparation<TService = unknown> {
  readonly routes?: readonly RouteEntry[]
  readonly create: (resources: Readonly<Record<string, unknown>>) => ServiceInstanceResult<TService>
}

/** Instance-owned domain runtime, resolving configuration before creating resource-bound services. */
export interface ServiceRuntime<TService = unknown> {
  readonly prepare: (
    env: unknown,
    config: ResolvedHttpConfig,
  ) => ServicePreparation<TService> | Promise<ServicePreparation<TService>>
}

/** Internal assembly selected by generated application code. */
export interface ServiceAssembly<TService = never> {
  /** Whether this domain exposes a public instance service. */
  readonly expose?: boolean
  /** Creates instance-owned caches without evaluating configuration factories. */
  readonly createRuntime: () => ServiceRuntime<TService>
  readonly $infer?: TService
}

/** Extracts a domain's public instance service. */
export type InferService<S> = S extends ServiceAssembly<infer T> ? T : never
