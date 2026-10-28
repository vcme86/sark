import { expect, it } from 'vitest'

import { applicationLifecycles } from '../../src/core/lifecycle'
import { createDefinition } from '../../src/entries/runtime/core'
import { createApp, route } from '../../src/entries/server'
import { parseApiFilePath } from '../../src/http/path'
import type { RouteDeclaration } from '../../src/http/types'

const entry = (file: string, declaration: RouteDeclaration) => ({
  routePath: parseApiFilePath(file, '/api')!,
  declaration,
})

it('shares concurrent instance close completion and rejects new external business', async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const app = await createApp(
    createDefinition({
      routes: [
        entry(
          'slow.get.ts',
          route().handler(async () => {
            entered.resolve()
            await release.promise
            return { ok: true }
          }),
        ),
        entry(
          'ping.get.ts',
          route().handler(() => 'ok'),
        ),
      ],
    }),
  )
  const accepted = app.fetch(new Request('http://localhost/api/slow'))
  await entered.promise
  const first = app.close(),
    second = app.close()
  try {
    expect(first).toBe(second)
    expect(app.state).toBe('draining')
    const rejected = await app.fetch(new Request('http://localhost/api/ping'))
    expect(rejected.status).toBe(503)
    expect(rejected.headers.get('X-Request-Id')).toBeTruthy()
  } finally {
    release.resolve()
    await accepted
    await Promise.all([first, second])
  }
  expect(app.state).toBe('closed')
})

it('allows accepted work to finish an internal call during draining', async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const app = await createApp(
    createDefinition({
      routes: [
        entry(
          'outer.get.ts',
          route().handler(async (): Promise<unknown> => {
            entered.resolve()
            await release.promise
            const response = await app.fetchInternal(new Request('http://localhost/api/inner'))
            return response.json()
          }),
        ),
        entry(
          'inner.get.ts',
          route().handler(() => ({ ok: true })),
        ),
      ],
    }),
  )
  const request = app.fetch(new Request('http://localhost/api/outer'))
  await entered.promise
  const closing = app.close()
  release.resolve()
  expect(await (await request).json()).toEqual({ ok: true })
  await closing
})

it('keeps draining until reverse resource disposal has finished', async () => {
  const app = await createApp(createDefinition())
  const release = Promise.withResolvers<void>()
  const disposing = Promise.withResolvers<void>()
  const order: string[] = []
  const lifecycle = applicationLifecycles.get(app)!
  lifecycle.register({
    name: 'first',
    dispose() {
      order.push('first')
    },
  })
  lifecycle.register({
    name: 'second',
    async dispose() {
      disposing.resolve()
      await release.promise
      order.push('second')
    },
  })
  const closing = app.close()
  await disposing.promise
  expect(app.state).toBe('draining')
  release.resolve()
  await closing
  expect(order).toEqual(['second', 'first'])
  expect(app.state).toBe('closed')
})
