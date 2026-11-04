import { setImmediate } from 'node:timers/promises'

import { integer, pgTable, text } from 'drizzle-orm/pg-core'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { startNodeServer } from '../../src/adapter/node/listen'
import { defineNodeRuntime } from '../../src/adapter/node/runtime'
import { createApp } from '../../src/app/create'
import { createDefinition } from '../../src/app/definition'
import { route } from '../../src/app/http/route'
import type { RouteDeclaration } from '../../src/app/http/types'
import { defineDatabase, type PostgresDatabase } from '../../src/features/db/postgres'
import { parseApiFilePath } from '../../src/http/path'

// The caller supplies an isolated database; the suite never creates or alters a server installation.
const databaseUrl = process.env.SARK_TEST_POSTGRES_URL
const users = pgTable('sark_p4_users', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
})
const schema = { users }
const entry = (file: string, declaration: RouteDeclaration) => ({
  routePath: parseApiFilePath(file, '/api')!,
  declaration,
})

function definition(routes: ReturnType<typeof entry>[] = []) {
  return createDefinition({
    resources: { db: defineDatabase({ url: databaseUrl!, schema: { users }, pool: { max: 1 } }) },
    routes,
  })
}

describe.skipIf(!databaseUrl)('PostgreSQL native resource lifecycle', () => {
  let observer: ReturnType<typeof postgres>
  beforeAll(async () => {
    observer = postgres(databaseUrl!, { max: 1 })
    await observer`create table if not exists sark_p4_users (id integer primary key, name text not null)`
  })
  beforeEach(async () => {
    await observer`delete from sark_p4_users`
  })
  afterAll(async () => {
    await observer?.end({ timeout: 0 })
  })

  it('executes API queries and preserves async transaction rollback and native pool settings', async () => {
    const app = await createApp(
      definition([
        entry(
          'users.get.ts',
          route().handler(async (c) => {
            const db = c.get('db' as never) as PostgresDatabase<typeof schema>
            return db.select().from(users)
          }),
        ),
      ]),
    )
    try {
      expect(app.db.$client.options.max).toBe(1)
      expect(app.db.$client.options.idle_timeout).toBe(30)
      expect(app.db.$client.options.connect_timeout).toBe(5)
      await expect(
        app.db.transaction(async (tx) => {
          await tx.insert(users).values({ id: 1, name: 'rolled back' })
          throw new Error('transaction failure')
        }),
      ).rejects.toThrow('transaction failure')
      expect(await app.db.select().from(users)).toEqual([])
      await app.db.transaction(async (tx) => {
        await tx.insert(users).values({ id: 2, name: 'committed' })
      })
      const response = await app.fetch(new Request('http://localhost/api/users'))
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual([{ id: 2, name: 'committed' }])
    } finally {
      await app.close()
    }
    await expect(app.db.$client`select 1`).rejects.toMatchObject({ code: 'CONNECTION_ENDED' })
  })

  it('passes fractional second timeouts to the real postgres.js client', async () => {
    const app = await createApp(
      createDefinition({
        resources: {
          db: defineDatabase({
            url: databaseUrl!,
            pool: { idleTimeout: 1500, connectTimeout: 2500 },
          }),
        },
      }),
    )
    try {
      expect(app.db.$client.options.idle_timeout).toBe(1.5)
      expect(app.db.$client.options.connect_timeout).toBe(2.5)
    } finally {
      await app.close()
    }
  })

  it('keeps the connection usable while an accepted request drains', async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const app = await createApp(
      definition([
        entry(
          'slow.get.ts',
          route().handler(async (c) => {
            entered.resolve()
            await release.promise
            const db = c.get('db' as never) as PostgresDatabase
            const [value] = await db.$client`select 42::integer as answer`
            return value
          }),
        ),
      ]),
    )
    const end = vi.spyOn(app.db.$client, 'end')
    const host = await startNodeServer(
      app,
      defineNodeRuntime({ port: 0, hostname: '127.0.0.1', compress: false }),
    )
    const response = fetch(`http://127.0.0.1:${host.port}/api/slow`).then((r) => r.json())
    await entered.promise
    const closing = host.close()
    try {
      await setImmediate()
      expect(end).not.toHaveBeenCalled()
      release.resolve()
      expect(await response).toEqual({ answer: 42 })
      await closing
      expect(end).toHaveBeenCalledOnce()
      expect(app.state).toBe('closed')
    } finally {
      release.resolve()
      await closing
    }
  })

  it('sets the remaining shutdown budget on the first native end call', async () => {
    const app = await createApp(definition())
    const client = app.db.$client
    const [{ pid }] = await client<{ pid: number }[]>`select pg_backend_pid() as pid`
    const pending = client`select pg_sleep(10) /* sark_p4_disposal */`.then(
      () => undefined,
      (error) => error,
    )
    const host = await startNodeServer(
      app,
      defineNodeRuntime({ port: 0, shutdown: { deadline: 500, reserve: 100 } }),
    )
    const end = vi.spyOn(client, 'end')
    try {
      await expect
        .poll(async () => {
          const [row] = await observer`select state from pg_stat_activity where pid = ${pid}`
          return row?.state
        })
        .toBe('active')
      await host.close().catch((error) => {
        expect(error.message).toContain('resource disposal exceeded')
      })
      expect(end).toHaveBeenCalledOnce()
      const timeout = end.mock.calls[0][0]?.timeout
      expect(timeout).toBeGreaterThan(0)
      expect(timeout).toBeLessThanOrEqual(0.5)
      expect(await pending).toMatchObject({ code: 'CONNECTION_DESTROYED' })
      await expect.poll(() => app.state).toBe('closed')
      await expect(client`select 1`).rejects.toMatchObject({ code: 'CONNECTION_ENDED' })
    } finally {
      await host.close().catch(() => {})
      await pending
      // Closing the client does not promise server-side query cancellation.
      await observer`select pg_cancel_backend(${pid})`
    }
  })

  it('cancels pending pool work when a later resource fails to initialize', async () => {
    let client: ReturnType<typeof postgres> | undefined
    let pending: Promise<unknown> | undefined
    let pid: number | undefined
    const database = defineDatabase({ url: databaseUrl! })
    const create = database.createStatic!
    const appDefinition = createDefinition({
      resources: {
        db: {
          ...database,
          async createStatic(...args: Parameters<typeof create>) {
            const result = await create(...args)
            client = result.value.$client
            return result
          },
        },
        failed: {
          target: 'node' as const,
          async createStatic() {
            const [backend] = await client!<{ pid: number }[]>`select pg_backend_pid() as pid`
            pid = backend.pid
            pending = client!`select pg_sleep(2) /* sark_p4_failed_startup */`.then(
              () => undefined,
              (error) => error,
            )
            await expect
              .poll(async () => {
                const [row] =
                  await observer`select state from pg_stat_activity where pid = ${backend.pid}`
                return row?.state
              })
              .toBe('active')
            throw new Error('later resource failed')
          },
        },
      },
    })
    try {
      await expect(createApp(appDefinition)).rejects.toThrow('later resource failed')
      expect(await pending).toMatchObject({ code: 'CONNECTION_DESTROYED' })
      await expect(client!`select 1`).rejects.toMatchObject({ code: 'CONNECTION_ENDED' })
    } finally {
      if (pid !== undefined) await observer`select pg_cancel_backend(${pid})`
      await client?.end({ timeout: 0 })
      await pending
    }
  })
})
