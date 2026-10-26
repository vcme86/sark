/**
 * Application definition assembly and type-level environment requirements.
 *
 * @module
 */

import type { Context } from 'hono'

import type { StaticAssets } from '../web/http/assets'
import type { HttpClient } from '../web/http/client/client'
import type { RouteEntry } from '../web/http/server/pipeline'
import type { AppDeclaration } from './config'
import type { RequestScope } from './context'
import type { EnvironmentRequirement } from './declaration'

/** Page-owned request handler installed by generated application assembly. */
export type PageRequestHandler = (
  context: Context,
  client: HttpClient<any>,
  scope: RequestScope,
  production: boolean,
) => Promise<Response>

/** Raw input parameters used to construct an application definition. */
export interface ApplicationDefinitionInput {
  /** Root application declaration created via `defineApp`. */
  app?: AppDeclaration
  /** Discovered route entries to register on the HTTP pipeline. */
  routes?: RouteEntry[]
  /** Supplementary declarations contributing static environment requirements. */
  declarations?: readonly unknown[]
  /** Optional server-side 404 page handler for HTML rendering. */
  page404Handler?: PageRequestHandler
  /** API prefix for routing and SSR internal client dispatch. */
  apiPrefix?: string
  /** Website URL prefix for page route mounting and HTML 404 scope. */
  webPrefix?: string
  /** Optional page declaration created via `definePage`. */
  page?: unknown
  /** Page-owned resolver called at instance creation or at the current external event. */
  resolvePageConfig?: (env: unknown) => unknown
  /** Build-owned public file mapping, independent of page and business initialization. */
  assets?: StaticAssets
}

/** Application declarations and routes assembled for runtime creation. */
export type ApplicationDefinition<
  TApp = AppDeclaration | undefined,
  Declarations extends readonly unknown[] = [],
  TPage = unknown,
> = {
  /** Root application declaration or `undefined` if none provided. */
  readonly appDeclaration?: TApp
  /** All assembled route entries ready for pipeline registration. */
  readonly routes: RouteEntry[]
  /** Optional server-side 404 page handler for HTML rendering. */
  readonly page404Handler?: PageRequestHandler
  /** API prefix for routing and SSR internal client dispatch. */
  readonly apiPrefix?: string
  /** Website URL prefix for page route mounting and HTML 404 scope. */
  readonly webPrefix?: string
  /** Optional page declaration created via `definePage`. */
  readonly page?: TPage
  /** Page-owned resolver called at instance creation or at the current external event. */
  readonly resolvePageConfig?: (env: unknown) => unknown
  /** Build-owned public file mapping, independent of page and business initialization. */
  readonly assets?: StaticAssets
  /** Discriminant flag identifying a compiled application definition. */
  readonly isDefinition: true
} & EnvironmentRequirement<readonly [TApp, TPage, ...Declarations]>

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
): ApplicationDefinition<
  T extends { app: infer A } ? A : undefined,
  T extends { declarations: infer D extends readonly unknown[] } ? D : [],
  T extends { page: infer P } ? P : undefined
> {
  return {
    appDeclaration: input.app,
    routes: input.routes ?? [],
    page404Handler: input.page404Handler,
    apiPrefix: input.apiPrefix,
    webPrefix: input.webPrefix,
    page: input.page,
    resolvePageConfig: input.resolvePageConfig,
    assets: input.assets,
    isDefinition: true,
  } as ApplicationDefinition<
    T extends { app: infer A } ? A : undefined,
    T extends { declarations: infer D extends readonly unknown[] } ? D : [],
    T extends { page: infer P } ? P : undefined
  >
}
