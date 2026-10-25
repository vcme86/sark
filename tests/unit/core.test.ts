import { describe, expect, it } from 'vitest'

import { defineNodeRuntime, resolveNodeRuntime } from '../../src/adapter/node/runtime'
import { createDefinition } from '../../src/entries/runtime/core'
import { createApp, dedup, defineApp, route, z } from '../../src/entries/server'
import { parseApiFilePath } from '../../src/web/http/path'
import { acceptsJson } from '../../src/web/http/server/output'

describe('Path and Routing Rules', () => {
  it('parses standard API file paths correctly', () => {
    const route1 = parseApiFilePath('users.[id].get.ts', '/api')
    expect(route1).not.toBeNull()
    expect(route1?.urlPath).toBe('/api/users/:id')
    expect(route1?.method).toBe('GET')

    const route2 = parseApiFilePath('site[.]webmanifest.get.ts', '/api')
    expect(route2?.urlPath).toBe('/api/site.webmanifest')

    const route3 = parseApiFilePath('(group).posts.[...slug].post.ts', '/api')
    expect(route3?.urlPath).toBe('/api/posts/:slug{.+}?')
    expect(route3?.clientPath).toBe('/api/posts/*slug')
    expect(route3?.method).toBe('POST')

    const route4 = parseApiFilePath('items.index.get.ts', '/api')
    expect(route4?.urlPath).toBe('/api/items')
  })
})

describe('Core Lifecycle & App Creation', () => {
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

  it('rejects creation when mutually exclusive body schemas are declared', () => {
    expect(() => {
      route().validate({
        json: z.object({ a: z.string() }),
        text: z.string(),
      })
    }).toThrow(/Mutually exclusive body schemas declared/)
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
})

describe('HTTP Negotiation & Status', () => {
  it('evaluates Accept header according to RFC 9110', () => {
    expect(acceptsJson(undefined)).toBe(true)
    expect(acceptsJson('')).toBe(true)
    expect(acceptsJson('application/json')).toBe(true)
    expect(acceptsJson('text/html, */*;q=0.8')).toBe(true)
    expect(acceptsJson('text/html')).toBe(false)
    expect(acceptsJson('application/json;q=0, */*;q=1')).toBe(false)
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
})

describe('Request dedup', () => {
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
})

describe('Node Runtime Configuration', () => {
  it('resolves port from config, env or default', () => {
    expect(resolveNodeRuntime(defineNodeRuntime({ port: 8080 })).port).toBe(8080)
    expect(resolveNodeRuntime(defineNodeRuntime(), { PORT: '5000' }).port).toBe(5000)
    expect(resolveNodeRuntime(defineNodeRuntime()).port).toBe(3000)
  })

  it('rejects invalid PORT values', () => {
    expect(() => resolveNodeRuntime(defineNodeRuntime(), { PORT: 'abc' })).toThrow(/Invalid PORT/)
    expect(() => resolveNodeRuntime(defineNodeRuntime({ port: 70000 }))).toThrow(/Invalid port/)
  })
})
