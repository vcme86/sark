/**
 * Cloudflare D1 database declaration and event binding initialization.
 *
 * @module
 */

import type { D1Database } from '@cloudflare/workers-types'
import { drizzle } from 'drizzle-orm/d1'

import type { RequiresEnv } from '../../core/declaration'
import { type DatabaseDeclaration, type DatabaseInput, evaluateDatabaseConfig } from './declaration'

/** Native D1 Drizzle result, including its official platform binding. */
type D1DatabaseInstance<Schema extends Record<string, unknown> = Record<string, never>> =
  ReturnType<typeof drizzle<Schema, D1Database>>

/** Configuration for the current Workers event's D1 binding. */
export interface D1Config<Schema extends Record<string, unknown> = Record<string, never>> {
  /** D1 binding supplied by the active Workers event. */
  binding: D1Database | undefined
  /** Imported Drizzle tables and relations. */
  schema?: Schema
}

/** D1 declaration retaining its schema and native result. */
export type D1Declaration<Schema extends Record<string, unknown> = Record<string, never>> =
  DatabaseDeclaration<'d1', D1Config<Schema>, D1DatabaseInstance<Schema>>

/** D1 settings with the current event's required binding validated. */
interface ResolvedD1Config<Schema extends Record<string, unknown> = Record<string, never>> {
  binding: D1Database
  schema?: Schema
}

/**
 * Declares a Cloudflare D1 database without accessing its binding.
 *
 * @param config - Database settings and optional Drizzle schema.
 * @returns A declaration assembled by the owning host.
 */
export function defineDatabase<TSchema extends Record<string, unknown> = Record<string, never>>(
  config: D1Config<TSchema>,
): D1Declaration<TSchema>

/**
 * Declares a Cloudflare D1 database resolved once per external Workers event.
 *
 * @param factory - Receives the owning instance or event environment and returns database settings.
 * @returns A declaration retaining the factory's environment requirements.
 */
export function defineDatabase<
  TSchema extends Record<string, unknown> = Record<string, never>,
  E = unknown,
>(factory: (env: E) => D1Config<TSchema>): D1Declaration<TSchema> & RequiresEnv<E>

export function defineDatabase<TSchema extends Record<string, unknown> = Record<string, never>>(
  input: DatabaseInput<D1Config<TSchema>>,
): D1Declaration<TSchema> {
  return {
    kind: 'database',
    driver: 'd1',
    target: 'cloudflare',
    value: input,
    isFactory: typeof input === 'function',
    createForEvent(env: unknown) {
      const config = resolveD1Config(input, env)
      return { value: drizzle(config.binding, { schema: config.schema }) }
    },
  }
}

/**
 * Resolves Cloudflare D1 configuration from the active event environment.
 *
 * @param input - Binding configuration or environment factory.
 * @param env - Current event bindings passed to the configuration factory.
 * @returns Binding and schema identities preserved from the declared settings.
 * @throws {Error} If the binding is absent or factory resolution fails.
 */
function resolveD1Config<TSchema extends Record<string, unknown> = Record<string, never>>(
  input: DatabaseInput<D1Config<TSchema>>,
  env: unknown,
): ResolvedD1Config<TSchema> {
  const raw = evaluateDatabaseConfig(input, env)

  if (!raw.binding) throw new Error('Cloudflare D1 database binding is required.')

  return {
    binding: raw.binding,
    schema: raw.schema,
  }
}
