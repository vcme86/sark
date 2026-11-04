/**
 * Application definition assembly and type-level environment requirements.
 *
 * @module
 */

import type { Context } from 'hono'

import type { CloudflareExecutionContext, ScheduledController } from '../adapter/cloudflare/types'
import type { HealthPreparation } from '../adapter/node/probes'
import type { StaticAssets } from '../http/assets'
import type { AppDeclaration } from './config'
import type { EnvironmentRequirement } from './declaration'
import type { AdmissionRuntime, PageRequestHandler, RouteEntry } from './http/assembly'
import type { ExecutionLogging } from './logging'
import type { ResourceAssembly } from './resource'
import type { ServiceAssembly } from './service'
import type { AppInstance } from './types'

export type { PageRequestHandler } from './http/assembly'

/** Assembly interface for declared runtime asset mounts. */
export interface AssetMountAssembly {
  /** URL prefixes handled by runtime asset mounts. */
  readonly prefixes: readonly string[]
  /** Creates a handler that serves a file or rejects a request; null continues dispatch. */
  createHandler(runtimeRoot?: string): (ctx: Context) => Promise<Response | null> | Response | null
}

/** Raw input parameters used to construct an application definition. */
export interface AppDefinitionInput {
  /** Root application declaration created via `defineApp`. */
  app?: AppDeclaration
  /** Optional page declaration created via `definePage`. */
  page?: unknown
  /** Supplementary declarations contributing static environment requirements. */
  declarations?: readonly unknown[]
  /** Assembled instance and event resources (e.g. database, storage). */
  resources?: Record<string, ResourceAssembly<any>>
  /** Assembled domain services conforming to the ServiceAssembly contract. */
  services?: Record<string, ServiceAssembly<any>>
  /** API prefix for routing and SSR internal client dispatch. */
  apiPrefix?: string
  /** Website URL prefix for page route mounting and HTML 404 scope. */
  webPrefix?: string
  /** Discovered route entries to register on the HTTP pipeline. */
  routes?: RouteEntry[]
  /** Optional server-side 404 page handler for HTML rendering. */
  page404Handler?: PageRequestHandler
  /** Creates a page-owned configuration resolver for each application runtime. */
  createPageConfigResolver?: () => (env: unknown) => unknown
  /** Node build-owned public file mapping; Workers use native Static Assets routing. */
  assets?: StaticAssets
  /** Runtime directory mounts declared via defineAssets from @olivaw/sark/node. */
  assetMounts?: AssetMountAssembly
  /** Prepared health configuration factory consumed by the Node host. */
  health?: HealthPreparation
  /** Selected output resource prepared and released by the logging domain. */
  logging?: ResourceAssembly<ExecutionLogging>
  /** Selected ingress policy factory owned by the rate-limit domain. */
  admission?: () => AdmissionRuntime
  /** Selected handler for a platform scheduled event. */
  scheduled?: (
    controller: ScheduledController,
    env: unknown,
    context: CloudflareExecutionContext,
    instance: AppInstance<any>,
  ) => Promise<void>
}

/** Application declarations and routes assembled for runtime creation. */
export type AppDefinition<
  TApp = AppDeclaration | undefined,
  Declarations extends readonly unknown[] = [],
  TPage = unknown,
  TResources = Record<string, ResourceAssembly<any>> | undefined,
  TServices = Record<string, ServiceAssembly<any>> | undefined,
> = {
  /** Root application declaration or `undefined` if none provided. */
  readonly app?: TApp
  /** Optional page declaration created via `definePage`. */
  readonly page?: TPage
  /** Assembled instance and event resources. */
  readonly resources?: TResources
  /** Assembled domain services. */
  readonly services?: TServices
  /** API prefix for routing and SSR internal client dispatch. */
  readonly apiPrefix?: string
  /** Website URL prefix for page route mounting and HTML 404 scope. */
  readonly webPrefix?: string
  /** All assembled route entries ready for pipeline registration. */
  readonly routes: RouteEntry[]
  /** Optional server-side 404 page handler for HTML rendering. */
  readonly page404Handler?: PageRequestHandler
  /** Creates a page-owned configuration resolver for each application runtime. */
  readonly createPageConfigResolver?: () => (env: unknown) => unknown
  /** Node build-owned public file mapping; Workers use native Static Assets routing. */
  readonly assets?: StaticAssets
  /** Runtime directory mounts declared via defineAssets from @olivaw/sark/node. */
  readonly assetMounts?: AssetMountAssembly
  /** Prepared health configuration factory consumed by the Node host. */
  readonly health?: HealthPreparation
  /** Selected output resource prepared and released by the logging domain. */
  readonly logging?: ResourceAssembly<ExecutionLogging>
  /** Selected ingress policy factory owned by the rate-limit domain. */
  readonly admission?: () => AdmissionRuntime
  /** Selected handler for a platform scheduled event. */
  readonly scheduled?: AppDefinitionInput['scheduled']
  /** Discriminant flag identifying a compiled application definition. */
  readonly isDefinition: true
} & EnvironmentRequirement<
  readonly [TApp, TPage, ...Declarations],
  (TResources extends undefined ? {} : TResources) & (TServices extends undefined ? {} : TServices)
>

type DefinitionFromInput<T extends AppDefinitionInput> = AppDefinition<
  T extends { app: infer A } ? A : undefined,
  T extends { declarations: infer D extends readonly unknown[] } ? D : [],
  T extends { page: infer P } ? P : undefined,
  T extends { resources: infer Res } ? Res : undefined,
  T extends { services: infer Services } ? Services : undefined
>

/**
 * Assembles configuration and routes without evaluating declaration factories.
 * Combines environment requirements at the type level. Owning configuration
 * resolvers evaluate declarations and validate their results at runtime.
 *
 * @param input - Configuration, route entries, and supplementary declarations.
 * @returns An application definition retaining its factory environment requirements.
 */
export function createDefinition<const T extends AppDefinitionInput>(
  input: T = {} as T,
): DefinitionFromInput<T> {
  return {
    app: input.app,
    page: input.page,
    resources: input.resources,
    services: input.services,
    apiPrefix: input.apiPrefix,
    webPrefix: input.webPrefix,
    routes: input.routes ?? [],
    page404Handler: input.page404Handler,
    createPageConfigResolver: input.createPageConfigResolver,
    assets: input.assets,
    assetMounts: input.assetMounts,
    health: input.health,
    logging: input.logging,
    admission: input.admission,
    scheduled: input.scheduled,
    isDefinition: true,
  } as DefinitionFromInput<T>
}
