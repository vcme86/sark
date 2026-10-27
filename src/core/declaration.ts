declare const environmentSymbol: unique symbol

/** Type-level tag indicating an environment requirement for a declaration. */
export interface RequiresEnv<E> {
  readonly [environmentSymbol]: (env: E) => void
}

/** Extracts the required environment type from a declaration. */
export type EnvOf<D> = D extends RequiresEnv<infer E> ? E : unknown

/** Recursively intersects required environments from a tuple of declarations. */
export type MergeEnvironments<Declarations extends readonly unknown[]> =
  Declarations extends readonly [infer First, ...infer Rest]
    ? EnvOf<First> & MergeEnvironments<Rest>
    : unknown

/** Arguments required by createApp depending on whether definition demands an environment. */
export type EnvironmentArgs<D> =
  D extends RequiresEnv<infer E> ? [options: { env: E }] : [options?: { env?: unknown }]

/** Base representation of any Sark configuration declaration. */
export interface BaseDeclaration<K extends string = string, T = unknown> {
  readonly kind: K
  readonly value: T | ((env: any) => T)
  readonly isFactory: boolean
}

/** Intersects resource environments before unknown requirements can absorb concrete inputs. */
type ResourceEnvironment<Resources> = [keyof Resources] extends [never]
  ? unknown
  : {
        [K in keyof Resources]: (env: EnvOf<Resources[K]>) => void
      }[keyof Resources] extends (env: infer E) => void
    ? E
    : unknown

/** Environment requirements contributed by declarations and selected resources. */
export type EnvironmentRequirement<Declarations extends readonly unknown[], Resources = {}> = [
  Extract<Declarations[number] | Resources[keyof Resources], RequiresEnv<never>>,
] extends [never]
  ? {}
  : RequiresEnv<MergeEnvironments<Declarations> & ResourceEnvironment<Resources>>
