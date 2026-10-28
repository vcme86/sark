import { once } from 'node:events'
import { join } from 'node:path'

import { expect, it } from 'vitest'

import { getCurrentScope } from '../../src/core/context'
import { createDefinition } from '../../src/core/definition'
import { parseApiFilePath } from '../../src/http/path'
import { route } from '../../src/http/server/route'
import { defineDatabase } from '../../src/services/db/sqlite'
import { sark } from '../../src/tooling/vite'
import { createDevHandoff } from '../helpers/dev-handoff'
import { createProject } from '../helpers/project'

it('keeps the old SQLite connection alive until development instance handoff drains its request', async () => {
  const project = createProject()
  project.write('app.ts', 'export const app = {}')
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const database = defineDatabase({ filename: ':memory:' })
  const create = database.createStatic!
  const clients: { open: boolean }[] = []
  const definition = createDefinition({
    resources: {
      db: {
        ...database,
        async createStatic(...args: Parameters<typeof create>) {
          const result = await create(...args)
          clients.push(result.value.$client)
          return result
        },
      },
    },
    routes: [
      {
        routePath: parseApiFilePath('slow.get.ts', '/api')!,
        declaration: route().handler(async () => {
          const db = getCurrentScope()!.resources!.db as Awaited<ReturnType<typeof create>>['value']
          entered.resolve()
          await release.promise
          return db.$client.prepare('select 1 as alive').get()
        }),
      },
    ],
  })
  const harness = await createDevHandoff(project.root, sark(), async () => ({ definition }))
  let replacement: Promise<Response> | undefined
  let update: Promise<unknown> | undefined
  const pending = harness.request('/api/slow')
  try {
    await entered.promise
    update = harness.invalidate(join(project.root, 'app.ts'))
    const received = once(harness.httpServer, 'request')
    replacement = harness.request('/api/slow')
    await received
    expect(clients).toHaveLength(1)
    expect(clients[0].open).toBe(true)
    release.resolve()
    expect(await (await pending).json()).toEqual({ alive: 1 })
    await update
    expect(await (await replacement).json()).toEqual({ alive: 1 })
    expect(clients).toHaveLength(2)
    expect(clients[0].open).toBe(false)
    expect(clients[1].open).toBe(true)
  } finally {
    release.resolve()
    await pending
    await update
    await replacement
    try {
      await harness.close()
    } finally {
      project.remove()
    }
  }
  expect(clients.every((client) => !client.open)).toBe(true)
})

it.each([false, true])(
  'drains development response streams before resource disposal (disconnect=%s)',
  async (disconnect) => {
    const project = createProject()
    project.write('app.ts', 'export const app = {}')
    const release = Promise.withResolvers<void>()
    const database = defineDatabase({ filename: ':memory:' })
    const create = database.createStatic!
    const clients: { open: boolean }[] = []
    const definition = createDefinition({
      resources: {
        db: {
          ...database,
          async createStatic(...args: Parameters<typeof create>) {
            const result = await create(...args)
            clients.push(result.value.$client)
            return result
          },
        },
      },
      routes: [
        {
          routePath: parseApiFilePath('stream.get.ts', '/api')!,
          declaration: route().handler((ctx) => {
            const db = getCurrentScope()!.resources!.db as Awaited<
              ReturnType<typeof create>
            >['value']
            return new Response(
              new ReadableStream({
                async start(controller) {
                  const encoder = new TextEncoder()
                  controller.enqueue(encoder.encode('started\n'))
                  await release.promise
                  if (ctx.req.raw.signal.aborted) return
                  const row = db.$client.prepare('select 42 as answer').get() as { answer: number }
                  controller.enqueue(encoder.encode(String(row.answer)))
                  controller.close()
                },
              }),
            )
          }),
        },
      ],
    })
    const harness = await createDevHandoff(project.root, sark(), async () => ({ definition }))
    let update: Promise<unknown> | undefined
    let replacement: Promise<Response> | undefined
    const controller = new AbortController()
    const response = await harness.request('/api/stream', { signal: controller.signal })
    const body = response.text().then(
      (text) => ({ text }),
      (error: unknown) => ({ error }),
    )
    try {
      update = harness.invalidate(join(project.root, 'app.ts'))
      const received = once(harness.httpServer, 'request')
      replacement = harness.request('/api/stream')
      await received
      expect(clients).toHaveLength(1)
      expect(clients[0].open).toBe(true)
      if (disconnect) {
        controller.abort()
        expect(await body).toHaveProperty('error')
        release.resolve()
      } else {
        release.resolve()
        expect(await body).toEqual({ text: 'started\n42' })
      }
      await update
      expect(await (await replacement).text()).toBe('started\n42')
      expect(clients).toHaveLength(2)
      expect(clients[0].open).toBe(false)
      expect(clients[1].open).toBe(true)
    } finally {
      release.resolve()
      try {
        await body
        await update
        const remaining = await replacement
        if (remaining && !remaining.bodyUsed) await remaining.body?.cancel()
      } finally {
        try {
          await harness.close()
        } finally {
          project.remove()
        }
      }
    }
    expect(clients.every((client) => !client.open)).toBe(true)
  },
)
