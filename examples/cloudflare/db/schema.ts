import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const reports = sqliteTable('reports', {
  id: integer('id').primaryKey(),
  recordedAt: text('recorded_at').notNull(),
})
