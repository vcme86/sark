import { once } from 'node:events'
import { join } from 'node:path'

import { expect, it } from 'vitest'

import { defineApp, resolveAppConfig } from '../../src/core/config'
import { getCurrentScope } from '../../src/core/context'
import { assembleApp, createApp } from '../../src/core/create'
import { createDefinition } from '../../src/core/definition'
import { defineDatabase } from '../../src/services/db/sqlite'
import { sark } from '../../src/tooling/vite'
import { parseApiFilePath } from '../../src/web/http/path'
import { route } from '../../src/web/http/server/route'
import { createDevHandoff } from '../helpers/dev-handoff'
import { createProject } from '../helpers/project'

it('cancels initialization before disposing acquired resources in reverse order', async () => {
  const failure = new Error('Later resource initialization failed')
  const released: string[] = []
  let initializationSignal: AbortSignal | undefined
  const resource = (name: string) => ({
    async createStatic(_env: unknown, { signal }: { signal: AbortSignal }) {
      initializationSignal = signal
      return {
        value: name,
        dispose({ signal: disposalSignal }: { signal: AbortSignal }) {
          expect(disposalSignal).toBe(signal)
          expect(disposalSignal.aborted).toBe(true)
          expect(disposalSignal.reason).toBe(failure)
          released.push(name)
        },
      }
    },
  })

  await expect(
    createApp(
      createDefinition({
        resources: {
          first: resource('first'),
          second: resource('second'),
          failed: {
            async createStatic() {
              throw failure
            },
          },
        },
      }),
    ),
  ).rejects.toBe(failure)
  expect(initializationSignal?.aborted).toBe(true)
  expect(released).toEqual(['second', 'first'])
})

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

it('reuses event resources for internal calls and isolates simultaneous events and applications', async () => {
  let creations = 0
  let entered = 0
  const interleaved = Promise.withResolvers<void>()
  const resource = {
    target: 'cloudflare' as const,
    createForEvent(env: unknown) {
      creations++
      return { value: { label: (env as { label: string }).label } }
    },
  }
  let dispatchInternal: (request: Request) => Promise<Response>
  let currentResource: () => { label: string }
  let otherResource: () => unknown
  const definition = createDefinition({
    app: defineApp({ csrf: false }),
    resources: { selected: resource },
    routes: [
      {
        routePath: parseApiFilePath('inner.get.ts', '/api')!,
        declaration: route().handler(() => currentResource()),
      },
      {
        routePath: parseApiFilePath('outer.get.ts', '/api')!,
        declaration: route().handler(async (c) => {
          const selected = currentResource()
          if (++entered === 2) interleaved.resolve()
          await interleaved.promise
          const inner = await (
            await dispatchInternal(new Request('http://localhost/api/inner'))
          ).json()
          expect(currentResource()).toBe(selected)
          expect(c.get('selected' as never)).toBe(selected)
          expect(getCurrentScope()?.resources?.selected).toBe(selected)
          expect(otherResource).toThrow('active event context')
          return { label: selected.label, inner: inner.label }
        }),
      },
    ],
  })
  const config = resolveAppConfig(definition.appDeclaration, undefined, false)
  const options = { kind: 'event' as const, resolve: () => config, errorConfig: config }
  const app = await assembleApp(definition, options)
  const other = await assembleApp(definition, options)
  currentResource = () => app.selected
  otherResource = () => other.selected
  dispatchInternal = (request) => app.fetchInternal(request)
  try {
    const responses = await Promise.all(
      ['first', 'second'].map((label) =>
        app.fetch(new Request('http://localhost/api/outer'), { label }),
      ),
    )
    expect(await Promise.all(responses.map((response) => response.json()))).toEqual([
      { label: 'first', inner: 'first' },
      { label: 'second', inner: 'second' },
    ])
    expect(creations).toBe(2)
    expect(currentResource).toThrow('active event context')
  } finally {
    await Promise.all([app.close(), other.close()])
  }
})
