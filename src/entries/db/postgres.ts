/**
 * Node.js PostgreSQL database entrypoint for Sark applications.
 *
 * @module
 */

export { defineDatabase, type PostgresDeclaration } from '../../services/db/postgres'
export type { PostgresConfig, PostgresPoolConfig } from '../../services/db/postgres'
