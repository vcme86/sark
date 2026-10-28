import { preview, type PreviewServer } from 'vite'
import { describe, expect, it } from 'vitest'

import { createProject, runProjectCli, serverUrl, viteEntry } from '../helpers/project'

describe('Database & Resource Assembly Contract', () => {
  describe('Cloudflare D1 Database Contract with Workerd Preview', () => {
    it('executes batch transactions, atomic rollback on SQL errors, and zero-row conditional updates via real workerd', async () => {
      const project = createProject()

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
    sark({ target: 'cloudflare', appEntry: 'app.ts', apiDir: 'api' }),
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
  })
})
