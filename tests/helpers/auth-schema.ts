import { getTableConfig as pgConfig, type PgTable } from 'drizzle-orm/pg-core'
import { getTableConfig as sqliteConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core'

/** Expected physical metadata from production schemas, independent of handwritten test DDL. */
export function sqliteTableMetadata(table: SQLiteTable) {
  const config = sqliteConfig(table)
  return {
    name: config.name,
    columns: config.columns.map((column) => ({
      name: column.name,
      type: column.getSQLType().toUpperCase(),
      notnull: Number(column.notNull),
      pk: Number(column.primary),
    })),
    indexes: config.indexes.map((index) => index.config.name!),
  }
}

/** Checks PostgreSQL scalar types, nullability and declared secondary indexes. */
export function postgresTableMetadata(table: PgTable) {
  const config = pgConfig(table)
  return {
    name: config.name,
    columns: config.columns.map((column) => ({
      name: column.name,
      type: column.getSQLType(),
      notnull: column.notNull,
    })),
    indexes: config.indexes.map((index) => index.config.name!),
  }
}
