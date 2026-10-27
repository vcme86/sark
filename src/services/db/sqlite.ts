/**
 * SQLite database declaration, initialization, and connection lifecycle.
 *
 * @module
 */

import { isAbsolute, resolve } from 'node:path'

import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'

import type { RequiresEnv } from '../../core/declaration'
import { type DatabaseDeclaration, type DatabaseInput, resolveDatabaseOptions } from './declaration'

/** Native SQLite Drizzle result, including its better-sqlite3 client. */
export type SqliteDatabase<Schema extends Record<string, unknown> = Record<string, never>> =
  ReturnType<typeof drizzle<Schema>>

/** Options for the Node SQLite database. */
export interface SqliteOptions<Schema extends Record<string, unknown> = Record<string, never>> {
  /** Database filename relative to the application runtime directory, or :memory:. */
  filename: string
  /** Imported Drizzle tables and relations. */
  schema?: Schema
}

/** SQLite declaration retaining its concrete schema and native result. */
export type SqliteDeclaration<Schema extends Record<string, unknown> = Record<string, never>> =
  DatabaseDeclaration<'sqlite', SqliteOptions<Schema>, SqliteDatabase<Schema>>

/** SQLite configuration after filename validation and path resolution. */
export interface ResolvedSqliteConfig<
  Schema extends Record<string, unknown> = Record<string, never>,
> {
  filename: string
  schema?: Schema
}

/**
 * Declares a SQLite database without opening a connection.
 *
 * @param options - Database settings and optional Drizzle schema.
 * @returns A declaration assembled by the owning host.
 */
export function defineDatabase<TSchema extends Record<string, unknown> = Record<string, never>>(
  options: SqliteOptions<TSchema>,
): SqliteDeclaration<TSchema>

/**
 * Declares a SQLite database resolved once during application creation.
 *
 * @param factory - Receives the owning instance or event environment and returns database settings.
 * @returns A declaration retaining the factory's environment requirements.
 */
export function defineDatabase<
  TSchema extends Record<string, unknown> = Record<string, never>,
  E = unknown,
>(factory: (env: E) => SqliteOptions<TSchema>): SqliteDeclaration<TSchema> & RequiresEnv<E>

export function defineDatabase<TSchema extends Record<string, unknown> = Record<string, never>>(
  optionsOrFactory: DatabaseInput<SqliteOptions<TSchema>>,
): SqliteDeclaration<TSchema> {
  return {
    kind: 'database',
    driver: 'sqlite',
    target: 'node',
    isFactory: typeof optionsOrFactory === 'function',
    value: optionsOrFactory,
    async createStatic(env: unknown) {
      const config = resolveSqliteConfig(optionsOrFactory, env)
      const { db, dispose } = await createSqliteDatabase(config)
      return { value: db, dispose }
    },
  }
}

/**
 * Resolves SQLite configuration and normalizes its file path.
 *
 * @param input - Database options or environment factory.
 * @param env - Environment passed to the configuration factory.
 * @param rootDir - Base directory for relative filenames; defaults to the current working directory.
 * @returns Validated settings with an absolute filename, or the unchanged :memory: identifier.
 * @throws {Error} If the filename is absent or invalid, or factory resolution fails.
 */
export function resolveSqliteConfig<
  TSchema extends Record<string, unknown> = Record<string, never>,
>(
  input: DatabaseInput<SqliteOptions<TSchema>>,
  env: unknown,
  rootDir = process.cwd(),
): ResolvedSqliteConfig<TSchema> {
  const raw = resolveDatabaseOptions(input, env)

  if (typeof raw.filename !== 'string' || raw.filename.length === 0)
    throw new Error('SQLite filename is required.')
  const filename =
    raw.filename === ':memory:'
      ? ':memory:'
      : isAbsolute(raw.filename)
        ? raw.filename
        : resolve(rootDir, raw.filename)

  return {
    filename,
    schema: raw.schema,
  }
}

/**
 * Enables foreign keys and a 5-second busy timeout, plus WAL for on-disk databases.
 * Initialization failure closes the connection before propagating the error.
 *
 * @param config - Resolved SQLite database configuration.
 * @returns Initialized Drizzle instance with native client and synchronous disposal function.
 */
export async function createSqliteDatabase<
  TSchema extends Record<string, unknown> = Record<string, never>,
>(
  config: ResolvedSqliteConfig<TSchema>,
): Promise<{
  db: SqliteDatabase<TSchema>
  dispose: () => void
}> {
  const client = new Database(config.filename, { timeout: 5000 })

  let db: SqliteDatabase<TSchema>
  try {
    client.pragma('foreign_keys = ON')
    if (config.filename !== ':memory:') {
      client.pragma('journal_mode = WAL')
    }
    db = drizzle(client, { schema: config.schema })
  } catch (error) {
    client.close()
    throw error
  }

  return {
    db,
    dispose: () => {
      client.close()
    },
  }
}
