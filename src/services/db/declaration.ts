/** Shared database declarations, without importing any driver or platform types. */

import type { BaseDeclaration } from '../../core/declaration'
import type { ResourceAssembly } from '../../core/resource'

/** Database declaration retaining its concrete options and resource result. */
export interface DatabaseDeclaration<Driver extends string, Options, Instance>
  extends BaseDeclaration<'database', Options>, ResourceAssembly<Instance> {
  readonly driver: Driver
}

/** Configuration input consumed by the owning database resolver. */
export type DatabaseInput<T> = T | ((env: any) => T)

/**
 * Evaluates a database configuration factory once at its host boundary.
 *
 * @param input - Options object or environment factory; nested schema and callbacks are preserved.
 * @param env - Current instance or event environment.
 * @returns The declared options object, retaining schema and binding identities.
 * @throws If the factory environment is missing or the result is not an options object.
 */
export function resolveDatabaseOptions<T extends object>(input: DatabaseInput<T>, env: unknown): T {
  let value: T
  if (typeof input === 'function') {
    if (env === undefined) {
      throw new Error('Environment required by database declaration factory was not provided.')
    }
    value = input(env)
  } else {
    value = input
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Database configuration must be an options object.')
  }
  return value
}
