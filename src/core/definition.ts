/**
 * Application definition assembly and type-level environment requirements.
 *
 * @module
 */

import type { Context } from 'hono'

import type { StaticAssets } from '../http/assets'
import type { PageRequestHandler, RouteEntry } from '../http/server/types'
import type { AppDeclaration } from './config'
import type { EnvironmentRequirement } from './declaration'
import type { ResourceAssembly } from './resource'
import type { ServiceAssembly } from './service'

export type { PageRequestHandler } from '../http/server/types'

/** Assembly interface for declared runtime asset mounts. */
export interface AssetMountAssembly {
  /** URL prefixes handled by runtime asset mounts. */
  readonly prefixes: readonly string[]
  /** Creates a handler that serves a file or rejects a request; null continues dispatch. */
  createHandler(runtimeRoot?: string): (ctx: Context) => Promise<Response | null> | Response | null
}

/** Raw input parameters used to construct an application definition. */
export interface ApplicationDefinitionInput {
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
  /** Build-owned public file mapping, independent of page and business initialization. */
  assets?: StaticAssets
  /** Runtime directory mounts declared via defineAssets from @olivaw/sark/assets/node. */
  assetMounts?: AssetMountAssembly
}

/** Application declarations and routes assembled for runtime creation. */
export type ApplicationDefinition<
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
  /** Build-owned public file mapping, independent of page and business initialization. */
  readonly assets?: StaticAssets
  /** Runtime directory mounts declared via defineAssets from @olivaw/sark/assets/node. */
  readonly assetMounts?: AssetMountAssembly
  /** Discriminant flag identifying a compiled application definition. */
  readonly isDefinition: true
} & EnvironmentRequirement<
  readonly [TApp, TPage, ...Declarations],
  (TResources extends undefined ? {} : TResources) & (TServices extends undefined ? {} : TServices)
>

type DefinitionFromInput<T extends ApplicationDefinitionInput> = ApplicationDefinition<
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
export function createDefinition<const T extends ApplicationDefinitionInput>(
  input: T = {} as T,
): DefinitionFromInput<T> {
  return {
    app: input.app,
    page: input.page,
    resources: input.resources,
    services: input.services ? orderServices(input.services) : undefined,
    apiPrefix: input.apiPrefix,
    webPrefix: input.webPrefix,
    routes: input.routes ?? [],
    page404Handler: input.page404Handler,
    createPageConfigResolver: input.createPageConfigResolver,
    assets: input.assets,
    assetMounts: input.assetMounts,
    isDefinition: true,
  } as DefinitionFromInput<T>
}

/** Orders only selected dependencies, reporting missing or cyclic composition before resources open. */
function orderServices(services: NonNullable<ApplicationDefinitionInput['services']>) {
  const ordered: typeof services = {}
  const visiting = new Set<string>()
  function visit(name: string) {
    if (Object.hasOwn(ordered, name)) return
    if (visiting.has(name)) throw new Error(`Cyclic service dependency: ${name}.`)
    const service = services[name]
    if (!service) throw new Error(`Required service "${name}" is not declared.`)
    visiting.add(name)
    for (const dependency of service.requires ?? []) visit(dependency)
    visiting.delete(name)
    ordered[name] = service
  }
  for (const name of Object.keys(services)) visit(name)
  return ordered
}
