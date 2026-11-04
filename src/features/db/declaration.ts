/** Shared database declarations, without importing any driver or platform types. */

import { type BaseDeclaration, evaluateDeclaration } from '../../app/declaration'
import type { ResourceAssembly } from '../../app/resource'

/** Database declaration retaining its concrete configuration and resource result. */
export interface DatabaseDeclaration<Driver extends string, Config, Instance>
  extends BaseDeclaration<'database', Config>, ResourceAssembly<Instance> {
  readonly driver: Driver
}

/** Configuration input consumed by the owning database resolver. */
export type DatabaseInput<T> = T | ((env: any) => T)

/**
 * Evaluates a database configuration factory once at its host boundary.
 *
 * @param input - Configuration object or environment factory; nested schema and callbacks are preserved.
 * @param env - Current instance or event environment.
 * @returns The declared configuration object, retaining schema and binding identities.
 * @throws If the factory environment is missing or the result is not a configuration object.
 */
export function evaluateDatabaseConfig<T extends object>(input: DatabaseInput<T>, env: unknown): T {
  const value = evaluateDeclaration(input, env, 'database')
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Database configuration must be an object.')
  }
  return value
}
