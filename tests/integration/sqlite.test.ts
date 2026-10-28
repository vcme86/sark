import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { describe, expect, it } from 'vitest'

import type { ResourceAssembly } from '../../src/core/resource'
import { defineDatabase as defineSqlite } from '../../src/entries/db/sqlite'
import { createDefinition } from '../../src/entries/runtime/core'
import { createApp, route } from '../../src/entries/server'
import { parseApiFilePath } from '../../src/http/path'
import type { RouteDeclaration } from '../../src/http/types'

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
})
