/** Internal contracts for generated domain assembly and request bindings. */
import type { Logger } from '@logtape/logtape'
import type { Context } from 'hono'

import type { ResolvedHttpConfig } from './config'
import type { RouteEntry, SystemEndpoint } from './http/assembly'
import type { ShutdownContext } from './lifecycle'
import type { DisposalContext, ResourceAssembly } from './resource'
import type { AppInstance } from './types'

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

/** Fixed synchronous notifications from existing execution boundaries; observers never own work. */
export interface ExecutionObserver {
  /** Observes the start of an external HTTP request, including a WebSocket upgrade attempt. */
  onRequestStart?(): void
  /**
   * Observes completion once the request's delivery or upgrade outcome is known.
   *
   * @param method - Incoming HTTP method.
   * @param route - Selected template, or undefined when matching was unavailable.
   * @param status - Confirmed status, or undefined when delivery failed before confirmation.
   * @param duration - Elapsed time in milliseconds, including response delivery.
   */
  onRequestEnd?(
    method: string,
    route: string | undefined,
    status: number | undefined,
    duration: number,
  ): void
  /** Observes a connection only after the host confirms HTTP 101. */
  onSocketOpen?(): void
  /** Observes an accepted connection's release after its owned callback work has settled. */
  onSocketClose?(): void
  /** Observes actual job execution, excluding skipped triggers. */
  onJobStart?(name: string): void
  /** Observes a job's end after its handler settles, using the actual handler result. */
  onJobEnd?(name: string, result: 'success' | 'error'): void
  /** Reports a trigger skipped by overlap protection. */
  onJobSkip?(name: string): void
}

/** Domain facilities created after the application's resources are ready. */
export interface ServiceInitResult<TService = unknown> {
  readonly service?: TService
  readonly createBinding?: ServiceBindingFactory
  readonly observer?: ExecutionObserver
}

/** Lifecycle context passed to onReady service callbacks upon application readiness. */
export interface ServiceReadyContext {
  readonly app: AppInstance<any>
  readonly services: Readonly<Record<string, unknown>>
  readonly observers?: readonly ExecutionObserver[]
}

/** Context passed when creating resource-bound services. */
export interface ServiceCreateContext {
  readonly env?: unknown
  readonly target: 'node' | 'cloudflare'
  readonly resourceDeclarations: Readonly<Record<string, ResourceAssembly>>
  readonly signal: AbortSignal
  /** Instance cancellation independent of the initiating client. */
  readonly backgroundSignal: AbortSignal
  readonly drainingSignal?: AbortSignal
  /** Live Node host budget and current shutdown deadline; absent for event hosts. */
  readonly shutdown?: ShutdownContext
  readonly onReady?: (callback: (readyContext: ServiceReadyContext) => void | Promise<void>) => void
  readonly registerDispose: (
    name: string,
    dispose: (context: DisposalContext) => Promise<void> | void,
  ) => void
  readonly logger: Logger
  /** Tracks noncritical work until it settles before disposing its resources. */
  readonly waitUntil: (promise: Promise<unknown>) => void
}

/** Validated configuration and routes prepared before resources are created. */
export interface ServicePreparation<TService = unknown> {
  readonly routes?: readonly RouteEntry[]
  readonly endpoints?: readonly SystemEndpoint[]
  readonly create: (
    resources: Readonly<Record<string, unknown>>,
    context: ServiceCreateContext,
  ) => ServiceInitResult<TService> | Promise<ServiceInitResult<TService>>
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
