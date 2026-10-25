/**
 * Application definition assembly and type-level environment requirements.
 *
 * @module
 */

import type { RouteEntry } from '../web/http/server/pipeline'
import type { AppDeclaration } from './config'
import type { EnvironmentRequirement } from './declaration'

/** Raw input parameters used to construct an application definition. */
export interface ApplicationDefinitionInput {
  /** Root application declaration created via `defineApp`. */
  app?: AppDeclaration
  /** Discovered route entries to register on the HTTP pipeline. */
  routes?: RouteEntry[]
  /** Supplementary declarations contributing static environment requirements. */
  declarations?: readonly unknown[]
}

/** Application declarations and routes assembled for runtime creation. */
export type ApplicationDefinition<
  TApp = AppDeclaration | undefined,
  Declarations extends readonly unknown[] = [],
> = {
  /** Root application declaration or `undefined` if none provided. */
  readonly appDeclaration?: TApp
  /** All assembled route entries ready for pipeline registration. */
  readonly routes: RouteEntry[]
  /** Discriminant flag identifying a compiled application definition. */
  readonly isDefinition: true
} & EnvironmentRequirement<readonly [TApp, ...Declarations]>

/**
 * Assembles configuration and routes without evaluating declaration factories.
 * Combines factory environment requirements at the type level; runtime validation
 * remains the responsibility of each factory.
 *
 * @param input - Configuration, route entries, and supplementary declarations.
 * @returns An application definition retaining its factory environment requirements.
 */
export function createDefinition<const T extends ApplicationDefinitionInput>(
  input: T = {} as T,
): ApplicationDefinition<
  T extends { app: infer A } ? A : undefined,
  T extends { declarations: infer D extends readonly unknown[] } ? D : []
> {
  return {
    appDeclaration: input.app,
    routes: input.routes ?? [],
    isDefinition: true,
  } as ApplicationDefinition<
    T extends { app: infer A } ? A : undefined,
    T extends { declarations: infer D extends readonly unknown[] } ? D : []
  >
}
