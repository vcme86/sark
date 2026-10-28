import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { describe, expect, it } from 'vitest'

import { assembleApp } from '../../src/core/create'
import { defineDatabase as defineD1 } from '../../src/entries/db/d1'
import { defineDatabase as definePostgres } from '../../src/entries/db/postgres'
import { defineDatabase as defineSqlite } from '../../src/entries/db/sqlite'
import { createDefinition } from '../../src/entries/runtime/core'
import { createApp, defineApp, route } from '../../src/entries/server'
import { parseApiFilePath } from '../../src/http/path'
import type { RouteDeclaration } from '../../src/http/types'
import { resolvePostgresConfig } from '../../src/services/db/postgres'

const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
})

const entry = (file: string, declaration: RouteDeclaration) => ({
  routePath: parseApiFilePath(file, '/api')!,
  declaration,
})

describe('Database & Resource Assembly Contract', () => {
  it.each(['sqlite', 'postgres'] as const)(
    'rejects missing %s environment configuration before opening a connection',
    async (driver) => {
      const db =
        driver === 'sqlite'
          ? defineSqlite((env: NodeJS.ProcessEnv) => ({ filename: env.DATABASE_FILE }))
          : definePostgres((env: NodeJS.ProcessEnv) => ({ url: env.DATABASE_URL }))
      await expect(createApp(createDefinition({ resources: { db } }), { env: {} })).rejects.toThrow(
        driver === 'sqlite' ? /filename/ : /url/,
      )
    },
  )

  describe('Cloudflare D1 Database Contract with Workerd Preview', () => {
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
