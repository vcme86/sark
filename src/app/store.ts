/**
 * Shared contract for delayed store declarations and lifecycle cleanup.
 *
 * @module
 */

import type { Logger } from '@logtape/logtape'

import type { ResourceAssembly } from './resource'

/** Execution environment and initialized application resources available to store declarations. */
export interface StoreContext<Env = unknown> {
  readonly env?: Env
  readonly resources: Readonly<Record<string, unknown>>
  readonly resourceDeclarations: Readonly<Record<string, ResourceAssembly>>
  readonly logger: Logger
  readonly target: 'node' | 'cloudflare'
  readonly waitUntil: (promise: Promise<unknown>) => void
  readonly signal: AbortSignal
}

/** Result of initializing a dedicated store. */
export interface StoreInitResult<TStore> {
  readonly value: TStore
  /** Releases owned allocations; borrowed application resources remain with their owner. */
  readonly dispose?: () => Promise<void> | void
}

/** Factory declaration creating a domain-specific store when resources are ready. */
export interface StoreDeclaration<
  TStore,
  Env = unknown,
  Context extends StoreContext<Env> = StoreContext<Env>,
> {
  readonly target?: 'node' | 'cloudflare'
  /**
   * Initializes once per Node instance or external Worker event, after resources are ready.
   *
   * @param context - Actual environment, borrowed resources, logging and cancellation facilities.
   * @returns The store and optional cleanup for resources owned by this declaration.
   * @throws On failure; allocations not returned must be released by the creator itself.
   */
  readonly create: (context: Context) => StoreInitResult<TStore> | Promise<StoreInitResult<TStore>>
}

/** Validates declaration shape once while resolving the owning capability's configuration. */
export function validateStoreDeclaration(declaration: unknown, name: string): void {
  if (
    !declaration ||
    typeof declaration !== 'object' ||
    !('create' in declaration) ||
    typeof declaration.create !== 'function'
  )
    throw new Error(`${name} requires a store declaration with a create function.`)
}

/**
 * Creates one store and transfers only its owned disposal to the host.
 *
 * @param declaration - Delayed factory selected by the owning domain.
 * @param context - Current instance or event facilities with initialized borrowed resources.
 * @param name - Lifecycle name used for cleanup registration and errors.
 * @param registerDispose - Registers owned cleanup with the instance or event lifecycle.
 * @returns Initialized store with any owned cleanup registered.
 * @throws If the target is incompatible or initialization fails.
 */
export async function initializeStore<TStore, Context extends StoreContext>(
  declaration: StoreDeclaration<TStore, unknown, Context>,
  context: Context,
  name: string,
  registerDispose: (name: string, dispose: () => Promise<void> | void) => void,
): Promise<TStore> {
  if (declaration.target && declaration.target !== context.target)
    throw new Error(`${name} is incompatible with the ${context.target} target.`)
  const result = await declaration.create(context)
  if (result.dispose) registerDispose(name, result.dispose)
  return result.value
}
