import { describe, expect, expectTypeOf, it } from 'vitest'

import { defineStats } from '../../../src/features/stats/declaration'
import type { InferStatsCounters } from '../../../src/features/stats/types'
import { checkGeneratedTypes } from '../../helpers/typecheck'

interface Fixture {
  app: string
  route?: string
  files?: Record<string, string>
  target?: 'node' | 'cloudflare'
  customHost?: boolean
}

function compileFixture(fixture: Fixture) {
  return checkGeneratedTypes(
    {
      'app.ts': fixture.app,
      ...(fixture.route ? { 'api/test.get.ts': fixture.route } : {}),
      ...fixture.files,
    },
    { target: fixture.target, customHost: fixture.customHost },
  )
}

function expectCompiled(result: Awaited<ReturnType<typeof compileFixture>>) {
  expect(result.status, result.output).toBe(0)
}

describe('Stats generated type contracts (P12)', () => {
  it('registers ScopedStatsService on ctx.var.stats with precise counter names and uniqueCount inferences', async () => {
    expectCompiled(
      await compileFixture({
        app: `import { defineApp } from '@olivaw/sark'
import { defineDatabase } from '@olivaw/sark/db/sqlite'
import { defineVisitors } from '@olivaw/sark/visitors'
import { defineStats } from '@olivaw/sark/stats'
import { sqlStats } from '@olivaw/sark/stats/sqlite'

export const app = defineApp({ hosts: 'localhost' })
export const database = defineDatabase({ filename: ':memory:' })
export const visitors = defineVisitors({ secret: 'my-secret-key-at-least-32-chars!' })
export const stats = defineStats({
  store: sqlStats({ database }),
  counters: {
    articleViews: { uniqueBy: 'visitor' },
    downloads: { uniqueBy: false },
  },
})
`,
        route: `import { route } from '@olivaw/sark'

export default route().handler(async (ctx) => {
  const stats = ctx.var.stats

  // Legal increment calls
  await stats.increment('articleViews', { key: 'art-1', period: '2026-11-05' })
  await stats.increment('downloads', { key: 'pkg-1' })

  // Read results inference
  const viewRes = await stats.read('articleViews', { key: 'art-1' })
  const viewCount: number = viewRes.count
  const viewUnique: number = viewRes.uniqueCount

  const dlRes = await stats.read('downloads', { key: 'pkg-1' })
  const dlCount: number = dlRes.count
  // @ts-expect-error uniqueCount does not exist on uniqueBy: false counter
  const dlUnique = dlRes.uniqueCount

  // @ts-expect-error Unknown counter name rejected
  await stats.increment('unknownCounter', { key: 'x' })

  // @ts-expect-error Request-scoped increment must not accept subject override
  await stats.increment('articleViews', { key: 'art-1', subject: { kind: 'visitor', id: '1' } })

  return { viewCount, viewUnique, dlCount }
})`,
      }),
    )
  })

  it('exposes StatsService on JobContext.stats with explicit subject requirement', async () => {
    expectCompiled(
      await compileFixture({
        app: `import { defineApp } from '@olivaw/sark'
import { defineDatabase } from '@olivaw/sark/db/sqlite'
import { defineVisitors } from '@olivaw/sark/visitors'
import { defineStats } from '@olivaw/sark/stats'
import { sqlStats } from '@olivaw/sark/stats/sqlite'
import { defineJobs } from '@olivaw/sark/jobs'

export const app = defineApp({ hosts: 'localhost' })
export const database = defineDatabase({ filename: ':memory:' })
export const visitors = defineVisitors({ secret: 'my-secret-key-at-least-32-chars!' })
export const stats = defineStats({
  store: sqlStats({ database }),
  counters: {
    articleViews: { uniqueBy: 'visitor' },
    downloads: { uniqueBy: false },
  },
})
export const jobs = defineJobs([
  {
    name: 'sync-stats',
    schedule: '* * * * *',
    handler: async (ctx) => {
      const stats = ctx.stats

      // Legal background increment calls
      await stats.increment('articleViews', {
        key: 'art-1',
        subject: { kind: 'visitor', id: 'vis-10' },
      })
      await stats.increment('downloads', { key: 'pkg-1' })

      // @ts-expect-error Background increment on uniqueBy: visitor requires subject
      await stats.increment('articleViews', { key: 'art-1' })

      // @ts-expect-error Background increment on uniqueBy: visitor rejects mismatched kind
      await stats.increment('articleViews', { key: 'art-1', subject: { kind: 'user', id: 'u1' } })

      // @ts-expect-error Simple counter rejects subject
      await stats.increment('downloads', { key: 'pkg-1', subject: { kind: 'visitor', id: '1' } })
    },
  },
])
`,
      }),
    )
  })

  it('does not expose ctx.var.stats when stats is not exported in app', async () => {
    expectCompiled(
      await compileFixture({
        app: `import { defineApp } from '@olivaw/sark'

export const app = defineApp({ hosts: 'localhost' })
`,
        route: `import { route } from '@olivaw/sark'

export default route().handler(async (ctx) => {
  // @ts-expect-error stats must not exist when not enabled
  const stats = ctx.var.stats

  return { ok: true }
})`,
      }),
    )
  })
})

it('preserves generated instance counters, table requirements and factory environments', async () => {
  const result = await checkGeneratedTypes(
    {
      'app.ts': `import { defineApp } from '@olivaw/sark'
import { defineStats } from '@olivaw/sark/stats'
export const app = defineApp({})
export const stats = defineStats((env: { STATS_ENDPOINT: string }) => ({
  store: { create: () => ({ value: { record: async () => {}, read: async () => ({ count: 0, uniqueCount: 0 }) } }) },
  counters: { imports: { uniqueBy: 'subject' }, downloads: { uniqueBy: false } },
}))`,
      'contracts.ts': `import { createApp } from '@olivaw/sark'
import { defineDatabase } from '@olivaw/sark/db/sqlite'
import { sqlStats } from '@olivaw/sark/stats/sqlite'
import { definition } from './.build/app'
// @ts-expect-error The stats factory environment is required.
createApp(definition)
// @ts-expect-error The environment must satisfy the stats factory.
createApp(definition, { env: {} })
const app = await createApp(definition, { env: { STATS_ENDPOINT: 'test' } })
await app.stats.increment('downloads', { key: 'a' })
await app.stats.increment('imports', { key: 'a', subject: { kind: 'reader', id: '1' } })
// @ts-expect-error Unknown counter names are rejected on the instance too.
await app.stats.increment('other', { key: 'a' })
// @ts-expect-error A deduplicated instance operation needs an explicit subject.
await app.stats.increment('imports', { key: 'a' })
const result = await app.stats.read('downloads', { key: 'a' })
// @ts-expect-error Plain counters do not expose a unique count.
result.uniqueCount
const database = defineDatabase({ filename: ':memory:' })
// @ts-expect-error A custom table group requires counters.
sqlStats({ database, tables: {} })`,
    },
    { customHost: true },
  )
  expect(result.status, result.output).toBe(0)
})

it('infers literal modes from environment factories without caller assertions', () => {
  const declaration = defineStats((env: { ENDPOINT: string }) => ({
    counters: { downloads: { uniqueBy: false }, imports: { uniqueBy: 'subject' } },
    store: {
      create() {
        throw new Error(env.ENDPOINT)
      },
    },
  }))
  expectTypeOf<
    InferStatsCounters<typeof declaration>['downloads']['uniqueBy']
  >().toEqualTypeOf<false>()
  expectTypeOf<
    InferStatsCounters<typeof declaration>['imports']['uniqueBy']
  >().toEqualTypeOf<'subject'>()
})
