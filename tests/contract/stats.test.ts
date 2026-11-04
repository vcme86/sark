import { getLogger } from '@logtape/logtape'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { getTableConfig, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { resolveAppConfig } from '../../src/app/config'
import { createApp } from '../../src/app/create'
import { createDefinition } from '../../src/app/definition'
import type { ServiceAssembly } from '../../src/app/service'
import { defineAuth } from '../../src/entries/auth'
import { defineDatabase } from '../../src/entries/db/sqlite'
import { defineApp, route } from '../../src/entries/root'
import { createAuthAssembly } from '../../src/entries/runtime/auth'
import { createStatsAssembly } from '../../src/entries/runtime/stats'
import { createVisitorsAssembly } from '../../src/entries/runtime/visitors'
import { defineStats, StatsError } from '../../src/entries/stats'
import { sqlStats, statsCounters, statsSubjects } from '../../src/entries/stats/sqlite'
import { defineVisitors } from '../../src/entries/visitors'
import type { RequestAuth } from '../../src/features/auth/session/types'
import { createNodeJobsAssembly } from '../../src/features/jobs/assembly-node'
import { defineJobs } from '../../src/features/jobs/declaration'
import type { JobContext } from '../../src/features/jobs/types'
import { SqliteStatsStore } from '../../src/features/stats/db/sqlite'
import { resolveStatsConfig } from '../../src/features/stats/declaration'
import type {
  ScopedStatsService,
  StatsCountersConfig,
  StatsService,
  StatsStore,
  StatsStoreDeclaration,
} from '../../src/features/stats/types'
import type { RequestVisitor } from '../../src/features/visitors/types'
import { parseApiFilePath } from '../../src/http/path'
import { checkStatsStore, statsSchema } from '../helpers/stats-store-contracts'

const disposals: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const dispose of disposals.splice(0).toReversed()) await dispose()
})
const secret = 'stats-test-signing-secret-at-least-32-bytes'
const entry = (file: string, declaration: ReturnType<ReturnType<typeof route>['handler']>) => ({
  routePath: parseApiFilePath(file, '/api')!,
  declaration,
})
const unusedStore: StatsStoreDeclaration = {
  create() {
    throw new Error('Store must not be opened in configuration tests')
  },
}

function sqliteStore(subjects = true) {
  const raw = new Database(':memory:')
  disposals.push(() => {
    raw.close()
  })
  raw.exec(statsSchema[0])
  if (subjects) raw.exec(statsSchema[1])
  const db = drizzle(raw)
  return {
    raw,
    db,
    store: new SqliteStatsStore(db, statsCounters, subjects ? statsSubjects : undefined),
  }
}

async function appFixture<C extends StatsCountersConfig>(counters: C, identities = false) {
  const database = defineDatabase({ filename: ':memory:' })
  const stats = defineStats({
    store: sqlStats({ database }),
    counters,
    identities: { client: ({ request }) => request.headers.get('x-verified-client') },
  })
  const definition = createDefinition({
    app: defineApp({ csrf: false }),
    resources: { db: database },
    services: {
      ...(identities
        ? {
            auth: createAuthAssembly(defineAuth({ secret })),
            visitors: createVisitorsAssembly(defineVisitors({ secret })),
          }
        : {}),
      stats: createStatsAssembly(stats, { auth: identities, visitors: identities }),
    },
    routes: [
      entry(
        'stats.post.ts',
        route().handler(async (ctx) => {
          const input = await ctx.req.json()
          const variables = ctx.var as unknown as {
            visitor: RequestVisitor
            auth: RequestAuth
            stats: ScopedStatsService
          }
          try {
            if (input.op === 'ensure') return { id: await variables.visitor.ensure() }
            if (input.op === 'signin') {
              await variables.auth.signIn({ sub: input.sub })
              return { signedIn: true }
            }
            if (input.op === 'signout') {
              await variables.auth.signOut()
              return { signedOut: true }
            }
            if (input.op === 'read')
              return variables.stats.read(input.name, { key: input.key, period: input.period })
            await variables.stats.increment(input.name, {
              key: input.key,
              period: input.period,
              ...(input.subject ? { subject: input.subject } : {}),
            })
            return variables.stats.read(input.name, { key: input.key, period: input.period })
          } catch (error) {
            if (error instanceof StatsError) return ctx.json({ code: error.code }, 400)
            throw error
          }
        }),
      ),
    ],
  })
  const app = await createApp(definition)
  disposals.push(() => app.close())
  app.db.$client.exec(statsSchema.join(';'))
  return {
    app,
    call: (body: unknown, cookie = '', headers: Record<string, string> = {}) =>
      app.fetch(
        new Request('http://localhost/api/stats', {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie, ...headers },
          body: JSON.stringify(body),
        }),
      ),
  }
}

describe('Stats declarations and assembly', () => {
  it('validates options once at preparation, before opening resources', async () => {
    const opened = vi.fn(async () => ({ value: {} }))
    const declaration = defineStats({
      store: unusedStore,
      counters: { views: { uniqueBy: 'visitor' } },
    })
    await expect(
      createApp(
        createDefinition({
          resources: { test: { createStatic: opened } },
          services: { stats: createStatsAssembly(declaration) },
        }),
      ),
    ).rejects.toThrow('requires the visitors declaration')
    expect(opened).not.toHaveBeenCalled()
    for (const counters of [
      [],
      {},
      { '': { uniqueBy: false } },
      { views: { uniqueBy: 'invalid' } },
      { views: { uniqueBy: 'client' } },
    ]) {
      expect(() =>
        resolveStatsConfig(
          defineStats({ store: unusedStore, counters: counters as never }),
          undefined,
        ),
      ).toThrow()
    }
    const runtime = createStatsAssembly(
      defineStats((env: { mode: 'user' }) => ({
        store: unusedStore,
        counters: { views: { uniqueBy: env.mode } },
      })),
    ).createRuntime()
    expect(() =>
      runtime.prepare({ mode: 'user' }, resolveAppConfig(undefined, undefined, false)),
    ).toThrow('requires the auth declaration')
  })

  it('rejects incomplete explicit mappings without mixing default tables', async () => {
    const database = defineDatabase({ filename: ':memory:' })
    expect(() => sqlStats({ database, tables: {} as never })).toThrow('require counters')
    const stats = defineStats({
      store: sqlStats({ database, tables: { counters: statsCounters } }),
      counters: { views: { uniqueBy: 'subject' } },
    })
    await expect(
      createApp(
        createDefinition({
          resources: { db: database },
          services: { stats: createStatsAssembly(stats) },
        }),
      ),
    ).rejects.toThrow('require subjects')
  })

  it('awaits store creation and disposes once on shutdown or later creation failure', async () => {
    for (const fail of [false, true]) {
      const dispose = vi.fn()
      const store: StatsStore = {
        async record() {},
        async read() {
          return { count: 0 }
        },
      }
      const declaration = defineStats({
        counters: { hits: { uniqueBy: false } },
        store: {
          async create(context) {
            await Promise.resolve()
            expect(context.requirements.unique).toBe(false)
            return { value: store, dispose }
          },
        },
      })
      const failing: ServiceAssembly = {
        createRuntime: () => ({
          prepare: () => ({
            create() {
              throw new Error('later assembly failed')
            },
          }),
        }),
      }
      const creation = createApp(
        createDefinition({
          services: { stats: createStatsAssembly(declaration), ...(fail ? { failing } : {}) },
        }),
      )
      if (fail) await expect(creation).rejects.toThrow('later assembly failed')
      else {
        const app = await creation
        await app.close()
        await app.close()
      }
      expect(dispose).toHaveBeenCalledTimes(1)
    }
  })
})

describe('Stats request and instance contracts', () => {
  it('uses verified identities without creating identities or switching visitor subjects on login', async () => {
    const { app, call } = await appFixture(
      {
        visitors: { uniqueBy: 'visitor' },
        users: { uniqueBy: 'user' },
        clients: { uniqueBy: 'client' },
      },
      true,
    )
    for (const name of ['visitors', 'users', 'clients']) {
      const response = await call({ name, key: 'article' })
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ code: 'stats_subject_missing' })
      expect(response.headers.get('set-cookie')).toBeNull()
    }
    expect(app.db.$client.prepare('SELECT count(*) AS n FROM stats_counters').get()).toEqual({
      n: 0,
    })
    const initialized = await call({ op: 'ensure' })
    const visitorCookie = initialized.headers.getSetCookie()[0].split(';')[0]
    expect(await (await call({ name: 'visitors', key: 'article' }, visitorCookie)).json()).toEqual({
      count: 1,
      uniqueCount: 1,
    })
    const login = await call({ op: 'signin', sub: 'alice' }, visitorCookie)
    const authCookie = login.headers.getSetCookie()[0].split(';')[0]
    const cookie = `${visitorCookie}; ${authCookie}`
    expect(await (await call({ name: 'users', key: 'article' }, cookie)).json()).toEqual({
      count: 1,
      uniqueCount: 1,
    })
    expect(await (await call({ name: 'visitors', key: 'article' }, cookie)).json()).toEqual({
      count: 2,
      uniqueCount: 1,
    })
    await call({ op: 'signout' }, cookie)
    expect(await (await call({ name: 'visitors', key: 'article' }, visitorCookie)).json()).toEqual({
      count: 3,
      uniqueCount: 1,
    })
    expect(
      await (
        await call({ name: 'clients', key: 'api' }, '', { 'x-verified-client': 'client-a' })
      ).json(),
    ).toEqual({ count: 1, uniqueCount: 1 })
    expect(
      await (
        await call({ name: 'clients', key: 'api' }, '', { 'x-verified-client': 'client-a' })
      ).json(),
    ).toEqual({ count: 2, uniqueCount: 1 })
    const override = await call(
      { name: 'visitors', key: 'article', subject: { kind: 'visitor', id: 'other' } },
      cookie,
    )
    expect(await override.json()).toEqual({ code: 'stats_subject_invalid' })
  })

  it('keeps explicit service subjects and scope validation separate from request identity', async () => {
    const { app, call } = await appFixture({
      imports: { uniqueBy: 'subject' },
      hits: { uniqueBy: false },
    })
    for (const [options, code] of [
      [{ key: '' }, 'stats_key_invalid'],
      [{ key: 'a', period: '' }, 'stats_period_invalid'],
      [{ key: 'a\0b' }, 'stats_key_invalid'],
    ] as const) {
      await expect(app.stats.increment('hits', options)).rejects.toMatchObject({ code })
    }
    await expect(app.stats.increment('imports', { key: 'a' } as never)).rejects.toMatchObject({
      code: 'stats_subject_missing',
    })
    await expect(
      app.stats.increment('hits', { key: 'a', subject: { kind: 'user', id: '1' } } as never),
    ).rejects.toMatchObject({ code: 'stats_subject_invalid' })
    const subject = { kind: 'reader', id: 'r1' }
    await app.stats.increment('imports', { key: 'a', subject })
    expect(await (await call({ name: 'imports', key: 'a', subject })).json()).toEqual({
      count: 2,
      uniqueCount: 1,
    })
    const longKey = 'x'.repeat(600)
    await app.stats.increment('hits', { key: longKey, period: 'p'.repeat(150) } as never)
    expect(await app.stats.read('hits', { key: longKey, period: 'p'.repeat(150) })).toEqual({
      count: 1,
    })
  })
})

describe('SQLite stats persistence', () => {
  it('executes the shared storage contract with the exported physical schema', async () => {
    const { raw, store } = sqliteStore()
    for (const table of [statsCounters, statsSubjects]) {
      const config = getTableConfig(table)
      const columns = raw.prepare(`PRAGMA table_info(${config.name})`).all() as {
        name: string
        type: string
        notnull: number
        pk: number
      }[]
      expect(columns.map((c) => [c.name, c.type, c.notnull])).toEqual(
        config.columns.map((c) => [c.name, c.getSQLType().toUpperCase(), Number(c.notNull)]),
      )
      expect(
        columns
          .filter((c) => c.pk)
          .toSorted((a, b) => a.pk - b.pk)
          .map((c) => c.name),
      ).toEqual(config.primaryKeys[0].columns.map((c) => c.name))
      expect(config.indexes).toHaveLength(0)
    }
    await checkStatsStore(store)
  })

  it('needs only the counters table for ordinary counts and does not open an explicit transaction', async () => {
    const { raw, db, store } = sqliteStore(false)
    const transaction = vi.spyOn(db, 'transaction')
    await store.record({ name: 'hits', key: 'site' })
    expect(await store.read({ name: 'hits', key: 'site', unique: false })).toEqual({ count: 1 })
    expect(transaction).not.toHaveBeenCalled()
    expect(raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([
      { name: 'stats_counters' },
    ])
  })

  it('rolls back the counter when the second statement fails', async () => {
    const { raw, store } = sqliteStore()
    raw.exec(
      "CREATE TRIGGER fail_subject BEFORE INSERT ON stats_subjects BEGIN SELECT RAISE(ABORT, 'subject failed'); END",
    )
    await expect(
      store.record({ name: 'views', key: 'article', subject: { kind: 'user', id: 'a' } }),
    ).rejects.toThrow('subject failed')
    expect(await store.read({ name: 'views', key: 'article', unique: true })).toEqual({
      count: 0,
      uniqueCount: 0,
    })
  })

  it.each([true, false])(
    'supports custom mappings with constraint metadata: %s',
    async (constraints) => {
      const { raw, db } = sqliteStore()
      raw.exec(
        'DROP TABLE stats_counters; DROP TABLE stats_subjects; CREATE TABLE custom_counts (n TEXT NOT NULL, k TEXT NOT NULL, p TEXT NOT NULL, c INTEGER NOT NULL, PRIMARY KEY(n,k,p)); CREATE TABLE custom_subjects (n TEXT NOT NULL, k TEXT NOT NULL, p TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(n,k,p,kind,id))',
      )
      const counters = sqliteTable(
        'custom_counts',
        {
          name: text('n').notNull(),
          key: text('k').notNull(),
          period: text('p').notNull(),
          count: integer('c').notNull(),
        },
        (t) => (constraints ? [primaryKey({ columns: [t.name, t.key, t.period] })] : []),
      )
      const subjects = sqliteTable(
        'custom_subjects',
        {
          name: text('n').notNull(),
          key: text('k').notNull(),
          period: text('p').notNull(),
          kind: text('kind').notNull(),
          id: text('id').notNull(),
        },
        (t) =>
          constraints ? [primaryKey({ columns: [t.name, t.key, t.period, t.kind, t.id] })] : [],
      )
      const declaration = defineDatabase({ filename: ':memory:' })
      const { value: store } = await sqlStats({
        database: declaration,
        tables: { counters, subjects },
      }).create({
        resources: { db },
        resourceDeclarations: { db: declaration },
        target: 'node',
        logger: getLogger('test'),
        signal: new AbortController().signal,
        waitUntil() {},
        requirements: { unique: true },
      })
      await checkStatsStore(store)
    },
  )

  it('propagates a missing physical unique constraint and rolls back the counter', async () => {
    const { raw, db } = sqliteStore()
    raw.exec(
      'DROP TABLE stats_subjects; CREATE TABLE stats_subjects (name TEXT NOT NULL, key TEXT NOT NULL, period TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL)',
    )
    const database = defineDatabase({ filename: ':memory:' })
    const { value: store } = await sqlStats({
      database,
      tables: { counters: statsCounters, subjects: statsSubjects },
    }).create({
      resources: { db },
      resourceDeclarations: { db: database },
      target: 'node',
      logger: getLogger('test'),
      signal: new AbortController().signal,
      waitUntil() {},
      requirements: { unique: true },
    })
    await expect(
      store.record({ name: 'views', key: 'article', subject: { kind: 'user', id: 'a' } }),
    ).rejects.toThrow('ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint')
    expect(raw.prepare('SELECT count(*) AS count FROM stats_counters').get()).toEqual({ count: 0 })
    expect(raw.prepare('SELECT count(*) AS count FROM stats_subjects').get()).toEqual({ count: 0 })
  })
})

it('supplies the same instance-level stats service to a real Node job', async () => {
  const database = defineDatabase({ filename: ':memory:' })
  const definition = createDefinition({
    resources: { db: database },
    services: {
      stats: createStatsAssembly(
        defineStats({
          store: sqlStats({ database }),
          counters: { imports: { uniqueBy: 'subject' } },
        }),
      ),
      jobs: createNodeJobsAssembly(
        defineJobs([
          {
            name: 'import',
            schedule: { interval: 60_000 },
            handler: async (context: JobContext) => {
              const stats = (
                context as JobContext & {
                  stats: StatsService<{ imports: { uniqueBy: 'subject' } }>
                }
              ).stats
              await stats.increment('imports', { key: 'job', subject: { kind: 'batch', id: '1' } })
            },
          },
        ]),
      ),
    },
  })
  const app = await createApp(definition)
  disposals.push(() => app.close())
  app.db.$client.exec(statsSchema.join(';'))
  await app.jobs.get('import')!.run()
  expect(await app.stats.read('imports', { key: 'job' })).toEqual({ count: 1, uniqueCount: 1 })
})
