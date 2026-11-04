import { getTableConfig } from 'drizzle-orm/pg-core'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { PostgresStatsStore } from '../../src/features/stats/db/postgres'
import { statsCounters, statsSubjects } from '../../src/features/stats/schema/postgres'
import { checkStatsStore, statsSchema } from '../helpers/stats-store-contracts'

const url = process.env.SARK_TEST_POSTGRES_URL

// Use the supplied isolated server; never install or start a host database.
describe.skipIf(!url)('PostgreSQL stats persistence', () => {
  const namespace = `stats_${crypto.randomUUID().replaceAll('-', '')}`
  const client = postgres(url!, { max: 4, connection: { search_path: namespace } })
  const store = new PostgresStatsStore(drizzle(client), statsCounters, statsSubjects)
  beforeAll(async () => {
    await client.unsafe(`CREATE SCHEMA ${namespace}`)
    for (const statement of statsSchema) await client.unsafe(statement)
    await client.unsafe(
      "ALTER TABLE stats_subjects ADD CONSTRAINT reject_subject CHECK(id <> 'reject')",
    )
  })
  beforeEach(async () => {
    await client.unsafe('TRUNCATE stats_counters, stats_subjects')
  })
  afterAll(async () => {
    try {
      await client.unsafe(`DROP SCHEMA ${namespace} CASCADE`)
    } finally {
      await client.end({ timeout: 0 })
    }
  })

  it('executes the shared contract on real PostgreSQL', async () => {
    await checkStatsStore(store)
  })

  it('does not lose concurrent increments and deduplicates repeated subjects', async () => {
    await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        store.record({
          name: 'parallel',
          key: 'article',
          subject: { kind: 'user', id: String(i % 10) },
        }),
      ),
    )
    expect(await store.read({ name: 'parallel', key: 'article', unique: true })).toEqual({
      count: 40,
      uniqueCount: 10,
    })
  })

  it('reads one snapshot while distinct subjects are being recorded', async () => {
    const scope = { name: 'snapshot', key: 'article', unique: true }
    await Promise.all([
      ...Array.from({ length: 20 }, (_, i) =>
        store.record({ ...scope, subject: { kind: 'user', id: String(i) } }),
      ),
      ...Array.from({ length: 20 }, async () => {
        const result = await store.read(scope)
        expect(result.count).toBe(result.uniqueCount)
      }),
    ])
  })

  it('rolls back the counter when the subject constraint rejects the second statement', async () => {
    await expect(
      store.record({ name: 'rollback', key: 'article', subject: { kind: 'user', id: 'reject' } }),
    ).rejects.toThrow()
    expect(await store.read({ name: 'rollback', key: 'article', unique: true })).toEqual({
      count: 0,
      uniqueCount: 0,
    })
  })

  it('matches exported columns and composite uniqueness with the physical migration', async () => {
    const columns =
      await client`SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = ${namespace} ORDER BY table_name, ordinal_position`
    const tables = [statsCounters, statsSubjects].map(getTableConfig)
    expect(
      columns.map((row) => [row.table_name, row.column_name, row.data_type, row.is_nullable]),
    ).toEqual(
      tables.flatMap((table) =>
        table.columns.map((column) => [
          table.name,
          column.name,
          column.getSQLType(),
          column.notNull ? 'NO' : 'YES',
        ]),
      ),
    )
    const keys =
      await client`SELECT tc.table_name, kcu.column_name FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_schema = kcu.constraint_schema AND tc.constraint_name = kcu.constraint_name WHERE tc.table_schema = ${namespace} AND tc.constraint_type = 'PRIMARY KEY' ORDER BY tc.table_name, kcu.ordinal_position`
    expect(keys.map((row) => [row.table_name, row.column_name])).toEqual(
      tables.flatMap((table) =>
        table.primaryKeys[0].columns.map((column) => [table.name, column.name]),
      ),
    )
  })
})
