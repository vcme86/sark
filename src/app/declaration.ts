declare const environmentSymbol: unique symbol

/** Type-level tag indicating an environment requirement for a declaration. */
export interface RequiresEnv<E> {
  readonly [environmentSymbol]: (env: E) => void
}

/** Extracts the required environment type from a declaration. */
export type EnvOf<D> = D extends RequiresEnv<infer E> ? E : unknown

/** Recursively intersects required environments from a tuple of declarations. */
type MergeEnvironments<Declarations extends readonly unknown[]> = Declarations extends readonly [
  infer First,
  ...infer Rest,
]
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

/**
 * Evaluates a configuration value or environment factory without applying defaults.
 * The owning resolver validates the returned shape and fields.
 *
 * @param input - Static value or environment factory.
 * @param env - Environment supplied by the current host.
 * @param name - Declaration name used in the missing-environment diagnostic.
 * @returns The static value or the factory's result.
 * @throws If a factory requires an environment that the host did not supply.
 */
export function evaluateDeclaration<T>(
  input: T | ((env: any) => T),
  env: unknown,
  name: string,
): T {
  if (typeof input !== 'function') return input
  if (env === undefined) {
    throw new Error(`Environment required by ${name} declaration factory was not provided.`)
  }
  return (input as (env: unknown) => T)(env)
}

/** Intersects resource environments before unknown requirements can absorb concrete inputs. */
export type ResourceEnvironment<Resources> = [keyof Resources] extends [never]
  ? unknown
  : {
        [K in keyof Resources]-?: (env: EnvOf<Resources[K]>) => void
      }[keyof Resources] extends (env: infer E) => void
    ? E
    : unknown

/** Environment requirements contributed by declarations and selected resources. */
export type EnvironmentRequirement<Declarations extends readonly unknown[], Resources = {}> = [
  Extract<Declarations[number] | Resources[keyof Resources], RequiresEnv<never>>,
] extends [never]
  ? {}
  : RequiresEnv<MergeEnvironments<Declarations> & ResourceEnvironment<Resources>>
