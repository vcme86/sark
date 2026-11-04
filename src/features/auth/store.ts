/**
 * Shared contract for delayed store declarations and lifecycle cleanup.
 *
 * @module
 */

import type { Logger } from '@logtape/logtape'

import type { ResourceAssembly } from '../../app/resource'

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
  readonly dispose?: () => Promise<void> | void
}

/** Factory declaration creating a domain-specific store when resources are ready. */
export interface StoreDeclaration<TStore, Env = unknown> {
  readonly target?: 'node' | 'cloudflare'
  /**
   * Initializes once per Node instance or external Worker event, after resources are ready.
   * @param context - Actual environment, borrowed resources, logging and cancellation facilities.
   * @returns The store and optional cleanup for resources owned by this declaration.
   * @throws On failure; allocations not returned must be released by the creator itself.
   */
  readonly create: (
    context: StoreContext<Env>,
  ) => StoreInitResult<TStore> | Promise<StoreInitResult<TStore>>
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

/** Creates one store and transfers only its owned disposal to the host. */
export async function initializeStore<TStore>(
  declaration: StoreDeclaration<TStore>,
  context: StoreContext,
  name: string,
  registerDispose: (name: string, dispose: () => Promise<void> | void) => void,
): Promise<TStore> {
  if (declaration.target && declaration.target !== context.target)
    throw new Error(`${name} is incompatible with the ${context.target} target.`)
  const result = await declaration.create(context)
  if (result.dispose) registerDispose(name, result.dispose)
  return result.value
}
