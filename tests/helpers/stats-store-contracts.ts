/** Shared persistence assertions executed against real SQLite, PostgreSQL and D1 stores. */
import type { StatsStore } from '../../src/features/stats/types'

export const statsSchema = [
  'CREATE TABLE stats_counters (name TEXT NOT NULL, key TEXT NOT NULL, period TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (name, key, period))',
  'CREATE TABLE stats_subjects (name TEXT NOT NULL, key TEXT NOT NULL, period TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY (name, key, period, kind, id))',
]

function equal(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(
      `Stats contract mismatch: ${JSON.stringify(actual)}; expected ${JSON.stringify(expected)}`,
    )
}

/** Exercises accumulation, subject/scope isolation and empty reads through the same store contract. */
export async function checkStatsStore(store: StatsStore): Promise<void> {
  const scope = { name: 'views', key: 'article-1', unique: true }
  equal(await store.read(scope), { count: 0, uniqueCount: 0 })
  for (const subject of [
    { kind: 'user', id: 'a' },
    { kind: 'user', id: 'a' },
    { kind: 'user', id: 'b' },
    { kind: 'visitor', id: 'a' },
  ]) {
    await store.record({ ...scope, subject })
  }
  equal(await store.read(scope), { count: 4, uniqueCount: 3 })
  await store.record({ ...scope, period: 'day:1', subject: { kind: 'user', id: 'a' } })
  equal(await store.read({ ...scope, period: 'day:1' }), { count: 1, uniqueCount: 1 })
  equal(await store.read({ ...scope, key: 'article-2' }), { count: 0, uniqueCount: 0 })
  equal(await store.read({ ...scope, name: 'other' }), { count: 0, uniqueCount: 0 })
  equal(await store.read(scope), { count: 4, uniqueCount: 3 })
  await store.record({ name: 'downloads', key: 'package' })
  await store.record({ name: 'downloads', key: 'package' })
  equal(await store.read({ name: 'downloads', key: 'package', unique: false }), { count: 2 })
}
