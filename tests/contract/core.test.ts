import { expect, it } from 'vitest'

import { createApp, dedup, defineApp, route } from '../../src/entries/root'
import { createDefinition } from '../../src/entries/runtime/core'
import { parseApiFilePath } from '../../src/http/path'

it('creates an app instance and handles fetch request and close', async () => {
  const testRoute = route().handler((_ctx) => {
    return { message: 'hello sark' }
  })

  const parsedPath = parseApiFilePath('ping.get.ts', '/api')!
  const definition = createDefinition({
    app: defineApp({ bodyLimit: 1024 }),
    routes: [{ routePath: parsedPath, declaration: testRoute }],
  })

  const app = await createApp(definition)
  expect(app.state).toBe('ready')
  expect(Object.hasOwn(app, 'hono')).toBe(false)

  const req = new Request('http://localhost/api/ping', { method: 'GET' })
  const res = await app.fetch(req)

  expect(res.status).toBe(200)
  expect(res.headers.get('Content-Type')).toContain('application/json')
  expect(res.headers.get('X-Request-Id')).not.toBeNull()
  expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')

  const data = await res.json()
  expect(data).toEqual({ message: 'hello sark' })

  await app.close()
  expect(app.state).toBe('closed')
})

it('enforces environment requirement when app is declared with factory', async () => {
  interface CustomEnv {
    MY_VAR: string
  }

  const appDecl = defineApp((env: CustomEnv) => ({
    hosts: env.MY_VAR,
  }))

  const definition = createDefinition({ app: appDecl })

  // @ts-expect-error env is required
  await expect(createApp(definition)).rejects.toThrow(
    /Environment required by app declaration factory was not provided/,
  )

  const instance = await createApp(definition, { env: { MY_VAR: 'example.com' } })
  expect(instance.state).toBe('ready')
  await instance.close()
})

it('handles 405 Method Not Allowed with Allow header', async () => {
  const testRoute = route().handler(() => ({ ok: true }))
  const parsedPath = parseApiFilePath('items.get.ts', '/api')!
  const definition = createDefinition({
    routes: [{ routePath: parsedPath, declaration: testRoute }],
  })

  const app = await createApp(definition)
  const req = new Request('http://localhost/api/items', { method: 'POST' })
  const res = await app.fetch(req)

  expect(res.status).toBe(405)
  expect(res.headers.get('Allow')).toBe('GET, HEAD')

  const body = await res.json()
  expect(body.error.code).toBe('method_not_allowed')
  await app.close()
})

it('deduplicates function calls within execution scope', async () => {
  let callCount = 0
  const expensiveOperation = dedup(async (id: number) => {
    callCount++
    return { id, time: Date.now() }
  })

  const testRoute = route().handler(async () => {
    const first = await expensiveOperation(42)
    const second = await expensiveOperation(42)
    return { first, second, same: first === second, callCount }
  })

  const parsedPath = parseApiFilePath('dedup.get.ts', '/api')!
  const definition = createDefinition({
    routes: [{ routePath: parsedPath, declaration: testRoute }],
  })

  const app = await createApp(definition)
  const res = await app.fetch(new Request('http://localhost/api/dedup'))
  const data = await res.json()

  expect(data.same).toBe(true)
  expect(data.callCount).toBe(1)
  await app.close()
})
