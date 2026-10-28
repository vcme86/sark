/**
 * PostgreSQL database declaration, pool initialization, and connection lifecycle.
 *
 * @module
 */

import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

import type { RequiresEnv } from '../../core/declaration'
import type { DisposalContext } from '../../core/resource'
import { type DatabaseDeclaration, type DatabaseInput, evaluateDatabaseConfig } from './declaration'

/** Native postgres.js Drizzle result, including its client. */
export type PostgresDatabase<Schema extends Record<string, unknown> = Record<string, never>> =
  ReturnType<typeof drizzle<Schema>>

/** PostgreSQL connection pool overrides. */
export interface PostgresPoolConfig {
  /** Positive maximum connection count; defaults to 10. */
  max?: number
  /** Idle timeout in milliseconds; defaults to 30000. Zero disables the timer. */
  idleTimeout?: number
  /** Connection timeout in milliseconds; defaults to 5000. Zero disables the timer. */
  connectTimeout?: number
}

/** Configuration for the Node PostgreSQL database. */
export interface PostgresConfig<Schema extends Record<string, unknown> = Record<string, never>> {
  /** PostgreSQL connection URL. */
  url: string | undefined
  /** Imported Drizzle tables and relations. */
  schema?: Schema
  /** Connection pool limits and timeout overrides. */
  pool?: PostgresPoolConfig
}

/** PostgreSQL declaration retaining its schema and native result. */
export type PostgresDeclaration<Schema extends Record<string, unknown> = Record<string, never>> =
  DatabaseDeclaration<'postgres', PostgresConfig<Schema>, PostgresDatabase<Schema>>

/** PostgreSQL options with Sark pool defaults applied. */
interface ResolvedPostgresConfig<Schema extends Record<string, unknown> = Record<string, never>> {
  url: string
  schema?: Schema
  pool: Required<PostgresPoolConfig>
}

const DEFAULT_POOL = {
  max: 10,
  idleTimeout: 30000,
  connectTimeout: 5000,
} as const

/**
 * Declares a PostgreSQL database without opening a connection.
 *
 * @param config - Database settings and optional Drizzle schema.
 * @returns A declaration assembled by the owning host.
 */
export function defineDatabase<TSchema extends Record<string, unknown> = Record<string, never>>(
  config: PostgresConfig<TSchema>,
): PostgresDeclaration<TSchema>

/**
 * Declares a PostgreSQL database resolved once during application creation.
 *
 * @param factory - Receives the owning instance or event environment and returns database settings.
 * @returns A declaration retaining the factory's environment requirements.
 */
export function defineDatabase<
  TSchema extends Record<string, unknown> = Record<string, never>,
  E = unknown,
>(factory: (env: E) => PostgresConfig<TSchema>): PostgresDeclaration<TSchema> & RequiresEnv<E>

export function defineDatabase<TSchema extends Record<string, unknown> = Record<string, never>>(
  input: DatabaseInput<PostgresConfig<TSchema>>,
): PostgresDeclaration<TSchema> {
  return {
    kind: 'database',
    driver: 'postgres',
    target: 'node',
    value: input,
    isFactory: typeof input === 'function',
    async createStatic(env: unknown) {
      return createPostgresDatabase(resolvePostgresConfig(input, env))
    },
  }
}

/**
 * Resolves PostgreSQL configuration, validates ranges, and applies pool defaults.
 *
 * @param input - Database options or environment factory.
 * @param env - Environment passed to the configuration factory.
 * @returns Database settings with complete pool options in milliseconds.
 * @throws {Error} If the URL is absent, pool limits are invalid, or factory resolution fails.
 */
export function resolvePostgresConfig<
  TSchema extends Record<string, unknown> = Record<string, never>,
>(input: DatabaseInput<PostgresConfig<TSchema>>, env: unknown): ResolvedPostgresConfig<TSchema> {
  const raw = evaluateDatabaseConfig(input, env)

  if (typeof raw.url !== 'string' || raw.url.length === 0)
    throw new Error('PostgreSQL database url is required.')

  if (raw.pool?.max !== undefined) {
    if (!Number.isInteger(raw.pool.max) || raw.pool.max <= 0) {
      throw new Error(`PostgreSQL pool.max must be a positive integer, got ${raw.pool.max}.`)
    }
  }

  for (const field of ['idleTimeout', 'connectTimeout'] as const) {
    const value = raw.pool?.[field]
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      throw new Error(
        `PostgreSQL pool.${field} must be a non-negative finite number, got ${value}.`,
      )
    }
  }

  return {
    url: raw.url,
    schema: raw.schema,
    pool: {
      max: raw.pool?.max ?? DEFAULT_POOL.max,
      idleTimeout: raw.pool?.idleTimeout ?? DEFAULT_POOL.idleTimeout,
      connectTimeout: raw.pool?.connectTimeout ?? DEFAULT_POOL.connectTimeout,
    },
  }
}

/**
 * Creates, verifies, and initializes a PostgreSQL connection pool.
 * Converts millisecond timeouts to native second-based parameters without rounding.
 *
 * @param config - Resolved PostgreSQL database configuration.
 * @returns Initialized Drizzle instance and disposal function.
 */
async function createPostgresDatabase<
  TSchema extends Record<string, unknown> = Record<string, never>,
>(
  config: ResolvedPostgresConfig<TSchema>,
): Promise<{
  value: PostgresDatabase<TSchema>
  dispose: (context: DisposalContext) => Promise<void>
}> {
  const client = postgres(config.url, {
    max: config.pool.max,
    idle_timeout: config.pool.idleTimeout / 1000,
    connect_timeout: config.pool.connectTimeout / 1000,
  })

  let db: PostgresDatabase<TSchema>
  try {
    await client`select 1`
    db = drizzle(client, { schema: config.schema })
  } catch (error) {
    await client.end({ timeout: 0 })
    throw error
  }

  return {
    value: db,
    dispose: ({ signal, deadline }) => {
      // postgres.js reuses the first end() operation, so its timeout must be set once.
      const timeout = signal.aborted
        ? 0
        : deadline === undefined
          ? undefined
          : Math.max(0, deadline - performance.now()) / 1000
      return client.end({ timeout })
    },
  }
}
