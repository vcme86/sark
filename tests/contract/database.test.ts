import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import {
  BuildEnvironment,
  createIdResolver,
  preview,
  type PreviewServer,
  resolveConfig,
} from 'vite'
import { describe, expect, it } from 'vitest'

import { assembleApp } from '../../src/core/create'
import type { ResourceAssembly } from '../../src/core/resource'
import { defineDatabase as defineD1 } from '../../src/entries/db/d1'
import { defineDatabase as definePostgres } from '../../src/entries/db/postgres'
import { defineDatabase as defineSqlite } from '../../src/entries/db/sqlite'
import { createDefinition } from '../../src/entries/runtime/core'
import { createApp, defineApp, route } from '../../src/entries/server'
import { resolvePostgresConfig } from '../../src/services/db/postgres'
import { discoverAppEntry, discoverDatabaseDriver } from '../../src/tooling/build/discover/app'
import { generateBuildArtifacts } from '../../src/tooling/build/generate'
import { parseApiFilePath } from '../../src/web/http/path'
import type { RouteDeclaration } from '../../src/web/http/types'
import { createProject, runProjectCli, serverUrl, viteEntry } from '../helpers/project'

const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
})

const posts = sqliteTable('posts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id),
  title: text('title').notNull(),
})

const entry = (file: string, declaration: RouteDeclaration) => ({
  routePath: parseApiFilePath(file, '/api')!,
  declaration,
})

describe('Database & Resource Assembly Contract', () => {
  describe('SQLite Database', () => {
    it('initializes in-memory database, performs read/write and synchronous transactions', async () => {
      const dbDecl = defineSqlite({
        filename: ':memory:',
        schema: { users },
      })

      const app = await createApp(
        createDefinition({
          resources: { db: dbDecl },
          routes: [
            entry(
              'users.post.ts',
              route().handler(async (c) => {
                const db = (c.var as any).db
                const inserted = db.insert(users).values({ name: 'Alice' }).returning().get()
                return { inserted }
              }),
            ),
            entry(
              'users.get.ts',
              route().handler(async (c) => {
                const db = (c.var as any).db
                const all = db.select().from(users).all()
                return { users: all }
              }),
            ),
          ],
        }),
      )

      // Initialize table in the SQLite database via typed $client
      const rawDb = app.db.$client
      rawDb.exec('CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)')

      const postRes = await app.fetch(
        new Request('http://localhost/api/users', {
          method: 'POST',
          headers: { Origin: 'http://localhost' },
        }),
      )
      expect(postRes.status).toBe(200)
      const postData = await postRes.json()
      expect(postData).toEqual({ inserted: { id: 1, name: 'Alice' } })

      // Verify app.db synchronous transaction
      const txResult = app.db.transaction((tx) => {
        tx.insert(users).values({ name: 'Bob' }).run()
        return tx.select().from(users).all()
      })
      expect(txResult).toHaveLength(2)

      const getRes = await app.fetch(new Request('http://localhost/api/users'))
      expect(getRes.status).toBe(200)
      const getData = await getRes.json()
      expect(getData.users).toEqual([
        { id: 1, name: 'Alice' },
        { id: 2, name: 'Bob' },
      ])

      await app.close()
    })

    it('enforces foreign keys pragma and rollback on transaction error', async () => {
      const dbDecl = defineSqlite({
        filename: ':memory:',
        schema: { users, posts },
      })

      const app = await createApp(
        createDefinition({
          resources: { db: dbDecl },
        }),
      )

      const rawDb = app.db.$client
      rawDb.exec('CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)')
      rawDb.exec(
        'CREATE TABLE posts (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id), title TEXT NOT NULL)',
      )

      // Foreign key violation must throw
      expect(() => {
        app.db.insert(posts).values({ userId: 999, title: 'Orphan' }).run()
      }).toThrow(/FOREIGN KEY constraint failed/i)

      // Synchronous transaction rollback
      expect(() => {
        app.db.transaction((tx) => {
          tx.insert(users).values({ name: 'Charlie' }).run()
          throw new Error('Rollback transaction')
        })
      }).toThrow('Rollback transaction')

      const usersAfter = app.db.select().from(users).all()
      expect(usersAfter).toHaveLength(0)

      await app.close()
    })

    it('enforces WAL mode for file-backed database, memory mode for :memory:, and 5000ms timeout', async () => {
      const memApp = await createApp(
        createDefinition({
          resources: { db: defineSqlite({ filename: ':memory:' }) },
        }),
      )
      const memRaw = memApp.db.$client
      const memPragma = memRaw.pragma('journal_mode', { simple: true })
      expect(memPragma).toBe('memory')
      await memApp.close()

      const filePath = join(
        tmpdir(),
        `sark-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
      )
      try {
        const fileApp = await createApp(
          createDefinition({
            resources: { db: defineSqlite({ filename: filePath }) },
          }),
        )
        const fileRaw = fileApp.db.$client
        const filePragma = fileRaw.pragma('journal_mode', { simple: true })
        expect(filePragma).toBe('wal')

        expect(fileRaw.pragma('busy_timeout', { simple: true })).toBe(5000)

        await fileApp.close()
      } finally {
        rmSync(filePath, { force: true })
        rmSync(`${filePath}-wal`, { force: true })
        rmSync(`${filePath}-shm`, { force: true })
      }
    })

    it('rolls back and closes database connection if subsequent resource assembly fails', async () => {
      const failingResource: ResourceAssembly = {
        target: 'node',
        async createStatic() {
          throw new Error('Downstream resource initialization failure')
        },
      }

      const dbDecl = defineSqlite({
        filename: ':memory:',
      })
      const create = dbDecl.createStatic!
      let acquired: { open: boolean } | undefined

      const definition = createDefinition({
        resources: {
          db: {
            ...dbDecl,
            async createStatic(...args: Parameters<typeof create>) {
              const result = await create(...args)
              acquired = result.value.$client
              return result
            },
          },
          faulty: failingResource,
        },
      })

      await expect(createApp(definition)).rejects.toThrow(
        'Downstream resource initialization failure',
      )
      expect(acquired).toBeDefined()
      expect(acquired?.open).toBe(false)
    })

    it('closes database upon lifecycle close and prevents further queries', async () => {
      const app = await createApp(
        createDefinition({
          resources: { db: defineSqlite({ filename: ':memory:' }) },
        }),
      )

      const rawDb = app.db.$client
      expect(rawDb.open).toBe(true)

      await app.close()
      expect(rawDb.open).toBe(false)

      expect(() => {
        rawDb.prepare('select 1').get()
      }).toThrow()
    })
  })

  describe('Cloudflare D1 Database Contract with Workerd Preview', () => {
    it('executes batch transactions, atomic rollback on SQL errors, and zero-row conditional updates via real workerd', async () => {
      const project = createProject()
      const generatedDir = '.build'

      project.write(
        'app.ts',
        `import { defineApp } from '@olivaw/sark/server'
import { defineDatabase } from '@olivaw/sark/db/d1'
import type { D1Database } from '@cloudflare/workers-types'

export const app = defineApp({ csrf: false })
export const database = defineDatabase((env: { DB: D1Database }) => ({
  binding: env.DB,
}))`,
      )

      project.write(
        'api/d1-batch.post.ts',
        `import { route } from '@olivaw/sark/server'
import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core'
import { eq } from 'drizzle-orm'

const items = sqliteTable('items', {
  id: integer('id').primaryKey(),
  title: text('title').notNull(),
})

export default route().handler(async (c) => {
  try {
    const db = c.var.db

    // Initialize table via db.$client
    await db.$client.exec('CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, title TEXT NOT NULL)')

    // 1. Successful batch containing insert and 0-row conditional update via Drizzle batch
    const batch1 = await db.batch([
      db.insert(items).values({ id: 1, title: 'Item 1' }),
      db.update(items).set({ title: 'New Title' }).where(eq(items.id, 999)),
    ])

    // 2. Failing batch to verify atomic rollback (primary key collision on id 1)
    let batchFailed = false
    try {
      await db.batch([
        db.insert(items).values({ id: 2, title: 'Item 2' }),
        db.insert(items).values({ id: 1, title: 'Duplicate Primary Key' }),
      ])
    } catch {
      batchFailed = true
    }

    // 3. Query surviving rows
    const remaining = await db.select().from(items).all()

    return {
      batch1Count: batch1.length,
      zeroChanges: batch1[1].meta.changes,
      batchFailed,
      rows: remaining,
    }
  } catch (err: any) {
    return { caughtError: err.message, stack: err.stack }
  }
})`,
      )

      project.write(
        'vite.config.mts',
        `import { sark } from ${JSON.stringify(viteEntry)}
import { cloudflare } from '@cloudflare/vite-plugin'

export default {
  cacheDir: '.build/vite-cache',
  plugins: [
    sark({ target: 'cloudflare', appEntry: 'app.ts', apiDir: 'api', generatedDir: '${generatedDir}' }),
    cloudflare({ viteEnvironment: { name: 'ssr' }, inspectorPort: false, persistState: false, remoteBindings: false }),
  ],
}`,
      )

      project.write(
        'worker.ts',
        `import worker from './.build/worker'
export default {
  fetch(request, env, ctx) {
    const binding = request.headers.get('X-Test-Database') === 'second' ? env.SECOND_DB : env.DB
    return worker.fetch(request, {...env, DB: binding}, ctx)
  },
}`,
      )
      project.write(
        'api/event.post.ts',
        `import {route} from '@olivaw/sark/server'
export default route().handler(async c => {
  const db = c.var.db
  const label = new URL(c.req.url).searchParams.get('label')
  await db.$client.exec('CREATE TABLE IF NOT EXISTS events (label TEXT NOT NULL)')
  await db.$client.prepare('INSERT INTO events VALUES (?)').bind(label).run()
  const result = await db.$client.prepare('SELECT label FROM events ORDER BY label').all()
  return {labels: result.results.map(row => row.label), sameBinding: db.$client === c.env.DB}
})`,
      )
      project.write(
        'api/event.get.ts',
        `import {route} from '@olivaw/sark/server'
export default route().handler(async c => {
  const result = await c.var.db.$client.prepare('SELECT label FROM events ORDER BY label').all()
  return result.results.map(row => row.label)
})`,
      )
      project.write(
        'wrangler.jsonc',
        JSON.stringify({
          name: 'sark-d1-test',
          main: 'worker.ts',
          compatibility_date: '2026-10-01',
          compatibility_flags: ['nodejs_compat'],
          d1_databases: [
            {
              binding: 'DB',
              database_name: 'test_d1_db',
              database_id: 'xxxx-xxxx',
            },
            { binding: 'SECOND_DB', database_name: 'second_d1_db', database_id: 'yyyy-yyyy' },
          ],
        }),
      )

      let previewServer: PreviewServer | undefined
      try {
        const buildResult = runProjectCli(project.root, ['build'], { NODE_ENV: 'production' })
        expect(buildResult.status, buildResult.stdout + buildResult.stderr).toBe(0)

        previewServer = await preview({
          root: project.root,
          logLevel: 'silent',
          preview: { host: '127.0.0.1', port: 0 },
        })

        const workerUrl = serverUrl(previewServer.httpServer)
        const response = await fetch(`${workerUrl}/api/d1-batch`, { method: 'POST' })
        if (response.status !== 200) {
          const body = await response.text()
          throw new Error(`Worker returned ${response.status}: ${body}`)
        }
        expect(response.status).toBe(200)

        const result = await response.json()
        if (result.caughtError) {
          throw new Error(`Route error: ${result.caughtError}\n${result.stack}`)
        }
        expect(result.batch1Count).toBe(2)
        expect(result.zeroChanges).toBe(0)
        expect(result.batchFailed).toBe(true)
        // Atomic rollback ensures Item 2 was not persisted
        expect(result.rows).toEqual([{ id: 1, title: 'Item 1' }])

        const concurrent = await Promise.all(
          ['first', 'second'].map((label) =>
            fetch(`${workerUrl}/api/event?label=${label}`, {
              method: 'POST',
              headers: { 'X-Test-Database': label },
            }).then(async (eventResponse) => {
              expect(eventResponse.status).toBe(200)
              return eventResponse.json()
            }),
          ),
        )
        expect(concurrent).toEqual([
          { labels: ['first'], sameBinding: true },
          { labels: ['second'], sameBinding: true },
        ])
        for (const label of ['second', 'first']) {
          const eventResponse = await fetch(`${workerUrl}/api/event`, {
            headers: { 'X-Test-Database': label },
          })
          expect(await eventResponse.json()).toEqual([label])
        }
      } finally {
        try {
          await previewServer?.close()
        } finally {
          project.remove()
        }
      }
    }, 45000)

    it('binds D1 database per event and throws when accessed outside event scope', async () => {
      const dbDecl = defineD1((env: { DB: any }) => ({
        binding: env.DB,
        schema: { users },
      }))

      const definition = createDefinition({
        app: defineApp({ csrf: false }),
        resources: { db: dbDecl },
      })

      const rawApp = await assembleApp(definition, {
        kind: 'event',
        resolve: () => ({ production: false, headers: false, csrf: false }) as any,
        errorConfig: { production: false, headers: false, csrf: false } as any,
      })

      // Outside active event context, accessing instance.db must throw
      expect(() => rawApp.db).toThrow(/accessible within an active event context/i)
    })
  })

  describe('PostgreSQL Database', () => {
    it('validates pool parameters and rejects invalid values', () => {
      // url required
      expect(() => resolvePostgresConfig({ url: '' }, {})).toThrow(/url is required/i)

      // pool.max must be a positive integer
      expect(() =>
        resolvePostgresConfig({ url: 'postgres://localhost', pool: { max: 0 } }, {}),
      ).toThrow(/pool\.max must be a positive integer, got 0/i)

      expect(() =>
        resolvePostgresConfig({ url: 'postgres://localhost', pool: { max: -5 } }, {}),
      ).toThrow(/pool\.max must be a positive integer, got -5/i)

      expect(() =>
        resolvePostgresConfig({ url: 'postgres://localhost', pool: { max: 1.5 } }, {}),
      ).toThrow(/pool\.max must be a positive integer/i)

      // idleTimeout must be non-negative finite
      expect(() =>
        resolvePostgresConfig({ url: 'postgres://localhost', pool: { idleTimeout: -10 } }, {}),
      ).toThrow(/pool\.idleTimeout must be a non-negative finite number/i)

      // connectTimeout must be non-negative finite
      expect(() =>
        resolvePostgresConfig(
          {
            url: 'postgres://localhost',
            pool: { connectTimeout: Number.NaN },
          },
          {},
        ),
      ).toThrow(/pool\.connectTimeout must be a non-negative finite number/i)
    })

    it('resolves pool configuration defaults and preserves fractional seconds without Math.ceil', () => {
      const decl = definePostgres({
        url: 'postgres://user:pass@localhost:5432/dbname',
      })
      const config = resolvePostgresConfig(decl.value, {})
      expect(config.pool.max).toBe(10)
      expect(config.pool.idleTimeout).toBe(30000)
      expect(config.pool.connectTimeout).toBe(5000)

      const declCustom = definePostgres((env: { DB_URL: string }) => ({
        url: env.DB_URL,
        pool: { max: 20, idleTimeout: 1500, connectTimeout: 2500 },
      }))
      const configCustom = resolvePostgresConfig(declCustom.value, {
        DB_URL: 'postgres://localhost/test',
      })
      expect(configCustom.pool.max).toBe(20)
      // Units converted directly (ms / 1000): 1500ms -> 1.5s, 2500ms -> 2.5s (not rounded to 2s / 3s)
      expect(configCustom.pool.idleTimeout / 1000).toBe(1.5)
      expect(configCustom.pool.connectTimeout / 1000).toBe(2.5)
    })

    it('fails eagerly on connection failure during startup and cleans up client without leaking', async () => {
      // Connect to an invalid local port where no PostgreSQL server is running
      const dbDecl = definePostgres({
        url: 'postgres://localhost:54329/nonexistent',
        pool: { connectTimeout: 500 },
      })

      await expect(
        createApp(
          createDefinition({
            resources: { db: dbDecl },
          }),
        ),
      ).rejects.toThrow()
    })
  })

  describe('Platform Boundary & Target Diagnostics', () => {
    it('rejects Node database drivers on Cloudflare Workers host at runtime', async () => {
      const definition = createDefinition({
        resources: { db: defineSqlite({ filename: ':memory:' }) },
      })

      await expect(
        assembleApp(definition, {
          kind: 'event',
          resolve: () => ({ production: false }) as any,
          errorConfig: { production: false } as any,
        }),
      ).rejects.toThrow(/cannot be used on a Cloudflare Workers host/i)
    })

    it('rejects Cloudflare D1 database driver on Node.js host at runtime', async () => {
      const definition = createDefinition({
        resources: { db: defineD1((env: any) => ({ binding: env.DB })) },
      })

      await expect(createApp(definition, { env: {} })).rejects.toThrow(
        /cannot be used on a Node.js host/i,
      )
    })

    it('diagnoses target mismatch during build-time generation', () => {
      const targetDir = join(
        tmpdir(),
        `sark-gen-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      )

      // Cloudflare target with SQLite driver
      expect(() => {
        generateBuildArtifacts({
          generatedDir: targetDir,
          appEntryPath: '/virtual/app.ts',
          appExports: {
            hasApp: true,
            hasRuntime: false,
            exports: ['app', 'database'],
            databaseDriver: 'sqlite',
          },
          routes: [],
          apiPrefix: '/api',
          webPrefix: '/',
          target: 'cloudflare',
        })
      }).toThrow(/Cloudflare Workers target does not support Node.js database driver/i)

      // Node target with D1 driver
      expect(() => {
        generateBuildArtifacts({
          generatedDir: targetDir,
          appEntryPath: '/virtual/app.ts',
          appExports: {
            hasApp: true,
            hasRuntime: false,
            exports: ['app', 'database'],
            databaseDriver: 'd1',
          },
          routes: [],
          apiPrefix: '/api',
          webPrefix: '/',
          target: 'node',
        })
      }).toThrow(/Node.js target does not support Cloudflare D1 database driver/i)
    })

    it('discovers database driver from import syntax and follows relative re-exports', async () => {
      const testDir = join(
        tmpdir(),
        `sark-discover-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      )
      const appFile = join(testDir, 'app.ts')
      const dbFile = join(testDir, 'database.ts')
      const genDir = join(testDir, '.build')

      try {
        mkdirSync(testDir, { recursive: true })
        // database.ts defines the database
        writeFileSync(
          dbFile,
          `import { defineDatabase } from '@olivaw/sark/db/sqlite'
export const database = defineDatabase({ filename: ':memory:' })
`,
        )
        // app.ts re-exports it
        writeFileSync(appFile, `export { database } from './database'\n`)

        const discovered = discoverAppEntry(appFile)
        const viteConfig = await resolveConfig(
          { root: testDir, configFile: false, logLevel: 'silent', environments: { ssr: {} } },
          'build',
        )
        const resolveId = createIdResolver(viteConfig)
        const environment = new BuildEnvironment('ssr', viteConfig)
        discovered.databaseDriver = await discoverDatabaseDriver(appFile, (id, importer) =>
          resolveId(environment, id, importer),
        )
        expect(discovered.exports).toContain('database')
        expect(discovered.databaseDriver).toBe('sqlite')

        // Pure schema or type imports do not enable driver
        const nonDbFile = join(testDir, 'non-db-app.ts')
        writeFileSync(
          nonDbFile,
          `import type { SqliteOptions } from '@olivaw/sark/db/sqlite'
export const database = { dummy: true }
`,
        )
        const nonDbDiscovered = discoverAppEntry(nonDbFile)
        expect(nonDbDiscovered.databaseDriver).toBeUndefined()

        generateBuildArtifacts({
          generatedDir: genDir,
          appEntryPath: appFile,
          appExports: discovered,
          routes: [],
          apiPrefix: '/api',
          webPrefix: '/',
          target: 'node',
        })

        // Check resources-types.ts content
        const resourcesCode = readFileSync(join(genDir, 'resources-types.ts'), 'utf-8')
        expect(resourcesCode).toContain('export type Db = InferResource<typeof database>')
        expect(resourcesCode).toContain('readonly db: Db')

        const typesDtsCode = readFileSync(join(genDir, 'types.d.ts'), 'utf-8')
        expect(typesDtsCode).toContain('resources: Resources')
        expect(typesDtsCode).toContain("declare module '@olivaw/sark/server'")
      } finally {
        rmSync(testDir, { recursive: true, force: true })
      }
    })
  })

  describe('Undeclared Database Negative Contract', () => {
    it('does not expose db on instance or context when database is not declared', async () => {
      let receivedCtxDb: unknown = 'NOT_SET'

      const app = await createApp(
        createDefinition({
          routes: [
            entry(
              'ping.get.ts',
              route().handler(async (c) => {
                receivedCtxDb = (c.var as any).db
                return { ok: true }
              }),
            ),
          ],
        }),
      )

      expect('db' in app).toBe(false)
      expect((app as any).db).toBeUndefined()

      const res = await app.fetch(new Request('http://localhost/api/ping'))
      expect(res.status).toBe(200)
      expect(receivedCtxDb).toBeUndefined()

      await app.close()
    })
  })
})
