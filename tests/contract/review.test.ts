import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { createClient } from '../../src/entries/http'
import { createDefinition } from '../../src/entries/runtime/core'
import { startNodeServer } from '../../src/entries/runtime/node'
import {
  type AppConfig,
  createApp,
  dedup,
  defineApp,
  HttpError,
  route,
  type RouteDeclaration,
  type RouteHandler,
  setCookie,
  z,
} from '../../src/entries/server'
import { defineNodeRuntime } from '../../src/entries/server/node'
import { parseApiFilePath } from '../../src/web/http/path'
import type { RouteEntry } from '../../src/web/http/server/pipeline'

function entry(path: string, handlerOrDecl: RouteHandler | RouteDeclaration, method = 'get') {
  const file = path.endsWith('.ts')
    ? path
    : path.replace(/^\/api\//, '').replace(/:([a-zA-Z0-9_]+)/g, '[$1]') +
      `.${method.toLowerCase()}.ts`
  const declaration =
    typeof handlerOrDecl === 'function' ? route().handler(handlerOrDecl) : handlerOrDecl
  return { routePath: parseApiFilePath(file, '/api')!, declaration }
}

async function executeRequest(config: AppConfig, routeEntry: RouteEntry, request: Request) {
  const app = await createApp(createDefinition({ app: defineApp(config), routes: [routeEntry] }))
  try {
    return await app.fetch(request)
  } finally {
    await app.close()
  }
}

describe('Contract & Regression Suite', () => {
  it('package type exports point to real build files', () => {
    const pkgPath = join(process.cwd(), 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    for (const value of Object.values(pkg.exports) as Array<{ types: string }>) {
      expect(existsSync(join(process.cwd(), value.types))).toBe(true)
    }
  })

  it('HttpError preserves the application status', async () => {
    const res = await executeRequest(
      {},
      entry('/api/fail', () => {
        throw new HttpError(403, 'Denied')
      }),
      new Request('http://localhost/api/fail'),
    )
    expect(res.status).toBe(403)
  })

  it('application CORS policy is applied', async () => {
    const res = await executeRequest(
      { cors: { origin: 'https://frontend.example' } },
      entry('/api/ping', () => ({ ok: true })),
      new Request('http://localhost/api/ping', { headers: { Origin: 'https://frontend.example' } }),
    )
    expect(res.headers.get('access-control-allow-origin')).toBe('https://frontend.example')
  })

  it('dynamic parameter values preserve case', async () => {
    const res = await executeRequest(
      {},
      entry('/api/users/:id', (ctx: any) => ({ id: ctx.req.param('id') })),
      new Request('http://localhost/api/users/Alice'),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: 'Alice' })
  })

  it('configured cookie defaults are used', async () => {
    const res = await executeRequest(
      { cookie: { sameSite: 'strict', secure: true } },
      entry('/api/cookie', (ctx: any) => {
        setCookie(ctx, 'theme', 'dark')
        return { ok: true }
      }),
      new Request('http://localhost/api/cookie'),
    )
    expect(res.headers.get('set-cookie')).toEqual(expect.stringContaining('SameSite=Strict'))
    expect(res.headers.get('set-cookie')).toContain('Secure')
  })

  it('body limit counts bytes', async () => {
    const decl = route()
      .validate({ json: z.string() })
      .handler((_ctx, input) => input.json)

    const e = entry('/api/data', decl, 'post')

    const res = await executeRequest(
      { bodyLimit: 4, csrf: false },
      e,
      new Request('http://localhost/api/data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify('你'),
      }),
    )
    expect(res.status).toBe(413)
  })

  it('raw requests inherit client credentials and headers', async () => {
    let captured: Request | undefined
    const client = createClient({
      baseUrl: 'https://api.example/api',
      credentials: 'include',
      headers: { Authorization: 'Bearer demo' },
      fetch: async (req) => {
        captured = req
        return new Response(null, { status: 204 })
      },
    })
    await client.requestRaw('GET', '/ping')
    expect(captured?.credentials).toBe('include')
    expect(captured?.headers.get('Authorization')).toBe('Bearer demo')
  })

  it('header overrides are case insensitive', async () => {
    const res = await executeRequest(
      { headers: { 'x-frame-options': 'DENY' } },
      entry('/api/ping', () => ({ ok: true })),
      new Request('http://localhost/api/ping'),
    )
    expect(res.headers.get('x-frame-options')).toBe('DENY')
  })

  it('application middleware enforces the configured authorization', async () => {
    let ran = false
    const res = await executeRequest(
      {
        middleware: [
          (ctx: any) => {
            ran = true
            return ctx.text('Denied', 403)
          },
        ],
      },
      entry('/api/private', () => ({ secret: 'example' })),
      new Request('http://localhost/api/private'),
    )
    expect(ran).toBe(true)
    expect(res.status).toBe(403)
  })

  it('default CSRF protection rejects a cross-origin text POST', async () => {
    const e = entry('/api/write', () => ({ ok: true }), 'post')
    const res = await executeRequest(
      {},
      e,
      new Request('http://localhost/api/write', {
        method: 'POST',
        headers: { Origin: 'https://other.example', 'Content-Type': 'text/plain' },
        body: 'update',
      }),
    )
    expect(res.status).toBe(403)
  })

  it('dedup compares every argument in multi-argument calls', async () => {
    const fn = dedup(async (a: string, b: string) => `${a}:${b}`)
    const r = route().handler(async () => [await fn('user', 'one'), await fn('user', 'two')])
    const e = entry('/api/read', r)
    const res = await executeRequest({}, e, new Request('http://localhost/api/read'))
    const values = await res.json()
    expect(values).toEqual(['user:one', 'user:two'])
  })

  it('CORS preflight reaches the configured endpoint policy', async () => {
    const e = entry('/api/ping', () => ({ ok: true }))
    const res = await executeRequest(
      { cors: { origin: 'https://frontend.example' } },
      e,
      new Request('http://localhost/api/ping', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://frontend.example',
          'Access-Control-Request-Method': 'GET',
        },
      }),
    )
    expect(res.status).toBe(204)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://frontend.example')
  })

  it('additional CSRF origins retain the current origin', async () => {
    const e = entry('/api/write', () => ({ ok: true }), 'post')
    const res = await executeRequest(
      { csrf: { origins: ['https://frontend.example'] } },
      e,
      new Request('http://localhost/api/write', {
        method: 'POST',
        headers: { Origin: 'http://localhost', 'Content-Type': 'text/plain' },
        body: 'update',
      }),
    )
    expect(res.status).toBe(200)
  })

  it('cookie helpers use resolved factory configuration', async () => {
    const e = entry('/api/cookie', (ctx: any) => {
      setCookie(ctx, 'theme', 'dark')
      return { ok: true }
    })
    const app = await createApp(
      createDefinition({
        app: defineApp((env: any) => ({ cookie: { sameSite: env.sameSite, secure: true } })),
        routes: [e],
      }),
      { env: { sameSite: 'strict' } },
    )
    try {
      const res = await app.fetch(new Request('http://localhost/api/cookie'))
      expect(res.headers.get('Set-Cookie')).toEqual(expect.stringContaining('SameSite=Strict'))
    } finally {
      await app.close()
    }
  })

  it('redirects retain common response headers', async () => {
    const e = entry('/api/ping', () => ({ ok: true }))
    const res = await executeRequest({}, e, new Request('http://localhost/api/ping/'))
    expect(res.status).toBe(308)
    expect(res.headers.get('X-Request-Id')).toBeTruthy()
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
  })

  it('default case-insensitive matching accepts uppercase static segments', async () => {
    const e = entry('/api/users/:id', (ctx: any) => ({ id: ctx.req.param('id') }))
    const res = await executeRequest({}, e, new Request('http://localhost/api/USERS/Alice'))
    expect(res.status).toBe(308)
    expect(res.headers.get('Location')).toBe('http://localhost/api/users/Alice')
  })

  it('non-GET/HEAD trailing slash directly matches without redirect or mutating raw url', async () => {
    let capturedUrl = ''
    const e = entry(
      '/api/data',
      (ctx: any) => {
        capturedUrl = ctx.req.url
        return { ok: true }
      },
      'post',
    )
    const res = await executeRequest(
      {},
      e,
      new Request('http://localhost/api/data/', {
        method: 'POST',
        headers: { Origin: 'http://localhost' },
      }),
    )
    expect(res.status).toBe(200)
    expect(capturedUrl).toBe('http://localhost/api/data/')
  })

  it('non-GET/HEAD uppercase static segments directly match without mutating raw url', async () => {
    let capturedUrl = ''
    let capturedParam = ''
    const e = entry(
      '/api/users/:id',
      (ctx: any) => {
        capturedUrl = ctx.req.url
        capturedParam = ctx.req.param('id')
        return { id: capturedParam }
      },
      'post',
    )
    const res = await executeRequest(
      {},
      e,
      new Request('http://localhost/api/USERS/Alice', {
        method: 'POST',
        headers: { Origin: 'http://localhost' },
      }),
    )
    expect(res.status).toBe(200)
    expect(capturedUrl).toBe('http://localhost/api/USERS/Alice')
    expect(capturedParam).toBe('Alice')
  })

  it('405 Method Not Allowed matches dynamically on differing static casing and trailing slash', async () => {
    const e = entry('/api/users/:id', () => ({ ok: true }))
    const res = await executeRequest(
      {},
      e,
      new Request('http://localhost/api/USERS/Alice/', { method: 'DELETE' }),
    )
    expect(res.status).toBe(405)
    expect(res.headers.get('Allow')).toBe('GET, HEAD')
  })

  it('Node delivery-layer compression compresses responses when gzip requested', async () => {
    const e = entry('/api/large', () => ({ data: 'a'.repeat(2000) }))
    const app = await createApp(createDefinition({ app: defineApp(), routes: [e] }))
    const server = await startNodeServer(app, defineNodeRuntime({ port: 0 }))
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/large`, {
        headers: { 'Accept-Encoding': 'gzip' },
      })
      expect(res.status).toBe(200)
      expect(res.headers.get('content-encoding')).toBe('gzip')
    } finally {
      await server.close()
    }
  })

  it('preflight selects policy by requested method as well as path', async () => {
    const routes = [
      entry(
        'item.get.ts',
        route({ cors: { origin: 'https://reader.example' } }).handler(() => 'read'),
      ),
      entry(
        'item.post.ts',
        route({ cors: { origin: 'https://writer.example' } }).handler(() => 'write'),
        'post',
      ),
    ]
    const app = await createApp(createDefinition({ app: defineApp({ csrf: false }), routes }))
    try {
      const res = await app.fetch(
        new Request('http://localhost/api/item', {
          method: 'OPTIONS',
          headers: {
            Origin: 'https://reader.example',
            'Access-Control-Request-Method': 'GET',
          },
        }),
      )
      expect(res.status).toBe(204)
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://reader.example')
    } finally {
      await app.close()
    }
  })

  it('default Node probe endpoints are reachable', async () => {
    const app = await createApp(createDefinition({ app: defineApp({ csrf: false }) }))
    const server = await startNodeServer(app, defineNodeRuntime({ port: 0 }))
    try {
      const live = await fetch(`http://127.0.0.1:${server.port}/livez`)
      const ready = await fetch(`http://127.0.0.1:${server.port}/readyz`)
      expect([live.status, ready.status]).toEqual([200, 200])
    } finally {
      await server.close()
      await app.close()
    }
  })

  it('custom compression filter still excludes event streams', async () => {
    const e = entry(
      'events.get.ts',
      route().handler(
        () =>
          new Response('data: hello\n\n', {
            headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'private' },
          }),
      ),
    )
    const app = await createApp(createDefinition({ app: defineApp({ csrf: false }), routes: [e] }))
    const server = await startNodeServer(
      app,
      defineNodeRuntime({ port: 0, compress: { threshold: 0, contentTypeFilter: () => true } }),
    )
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/events`, {
        headers: { 'Accept-Encoding': 'gzip' },
      })
      expect(res.headers.get('Content-Encoding')).toBeNull()
      expect(res.headers.get('Cache-Control')).toContain('private')
    } finally {
      await server.close()
      await app.close()
    }
  })

  it('disables probe endpoints when probes option is false', async () => {
    const app = await createApp(createDefinition({ app: defineApp({ csrf: false }) }))
    const server = await startNodeServer(app, defineNodeRuntime({ port: 0, probes: false }))
    try {
      const live = await fetch(`http://127.0.0.1:${server.port}/livez`)
      const ready = await fetch(`http://127.0.0.1:${server.port}/readyz`)
      expect(live.status).toBe(404)
      expect(ready.status).toBe(404)
    } finally {
      await server.close()
      await app.close()
    }
  })

  it('partially overrides probe endpoints while retaining unconfigured defaults', async () => {
    const app = await createApp(createDefinition({ app: defineApp({ csrf: false }) }))
    const server = await startNodeServer(
      app,
      defineNodeRuntime({ port: 0, probes: { liveness: '/custom/live' } }),
    )
    try {
      const customLive = await fetch(`http://127.0.0.1:${server.port}/custom/live`)
      const defaultReady = await fetch(`http://127.0.0.1:${server.port}/readyz`)
      const oldLive = await fetch(`http://127.0.0.1:${server.port}/livez`)
      expect(customLive.status).toBe(200)
      expect((await customLive.json()).status).toBe('ok')
      expect(defaultReady.status).toBe(200)
      expect((await defaultReady.json()).status).toBe('ok')
      expect(oldLive.status).toBe(404)
    } finally {
      await server.close()
      await app.close()
    }
  })

  it('disables compression when compress option is false', async () => {
    const e = entry('/api/large-raw', () => ({ data: 'x'.repeat(3000) }))
    const app = await createApp(createDefinition({ app: defineApp(), routes: [e] }))
    const server = await startNodeServer(app, defineNodeRuntime({ port: 0, compress: false }))
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/large-raw`, {
        headers: { 'Accept-Encoding': 'gzip' },
      })
      expect(res.status).toBe(200)
      expect(res.headers.get('content-encoding')).toBeNull()
    } finally {
      await server.close()
      await app.close()
    }
  })

  it('overrides compression threshold with explicit threshold option', async () => {
    const e = entry('/api/threshold-test', () => ({ data: 'x'.repeat(2000) }))
    const app = await createApp(createDefinition({ app: defineApp(), routes: [e] }))
    const server = await startNodeServer(
      app,
      defineNodeRuntime({ port: 0, compress: { threshold: 5000 } }),
    )
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/threshold-test`, {
        headers: { 'Accept-Encoding': 'gzip' },
      })
      expect(res.status).toBe(200)
      expect(res.headers.get('content-encoding')).toBeNull()
    } finally {
      await server.close()
      await app.close()
    }
  })

  it('closing Node transport enters draining before accepted work completes', async () => {
    let enteredResolve: any
    let release: any
    const entered = new Promise((resolve) => {
      enteredResolve = resolve
    })
    const gate = new Promise((resolve) => {
      release = resolve
    })

    const e = entry(
      'slow.get.ts',
      route().handler(async () => {
        enteredResolve()
        await gate
        return { ok: true }
      }),
    )
    const app = await createApp(createDefinition({ app: defineApp({ csrf: false }), routes: [e] }))
    const server = await startNodeServer(app, defineNodeRuntime({ port: 0 }))

    const request = fetch(`http://127.0.0.1:${server.port}/api/slow`)
    await entered
    const closing = server.close()
    const stateWhileClosing = app.state
    release()
    await request
    await closing
    await app.close()
    expect(stateWhileClosing).toBe('draining')
  })

  it('array of upload files is encoded as multipart with repeated fields', async () => {
    let captured: Request | undefined
    const client = createClient({
      baseUrl: 'http://localhost/api',
      fetch: async (req) => {
        captured = req
        return new Response(null, { status: 204 })
      },
    })
    await client.post('/upload', {
      form: { files: [new File(['one'], 'one.txt'), new File(['two'], 'two.txt')] },
    })
    const data = await captured!.formData()
    const files = data.getAll('files') as File[]
    expect(files.map((file) => file.name)).toEqual(['one.txt', 'two.txt'])
    expect(await Promise.all(files.map((file) => file.text()))).toEqual(['one', 'two'])
  })

  it('multipart drops default Content-Type so Fetch can set its boundary', async () => {
    let captured: Request | undefined
    const client = createClient({
      baseUrl: 'http://localhost/api',
      headers: { 'Content-Type': 'application/json' },
      fetch: async (req) => {
        captured = req
        return new Response(null, { status: 204 })
      },
    })
    const form = new FormData()
    form.set('file', new File(['one'], 'one.txt'))
    await client.post('/upload', { form })
    expect(captured!.headers.get('Content-Type')).toMatch(/^multipart\/form-data; boundary=/)
  })

  it('non-JSON non-text HTTP error preserves decoded body', async () => {
    const client = createClient({
      baseUrl: 'http://localhost/api',
      fetch: async () =>
        new Response(new Uint8Array([1, 2]), {
          status: 502,
          headers: { 'Content-Type': 'application/octet-stream' },
        }),
    })
    let error: any
    try {
      await client.get('/download')
    } catch (e) {
      error = e
    }
    expect(error.status).toBe(502)
    expect(error.body).toBeInstanceOf(ArrayBuffer)
    expect([...new Uint8Array(error.body)]).toEqual([1, 2])
  })

  it('JSON Accept Vary does not mistake Accept-Encoding for Accept', async () => {
    const e = entry(
      'vary.get.ts',
      route({
        middleware: [
          async (ctx: any, next: any) => {
            ctx.header('Vary', 'Accept-Encoding')
            await next()
          },
        ],
      }).handler(() => ({ ok: true })),
    )
    const app = await createApp(createDefinition({ app: defineApp({ csrf: false }), routes: [e] }))
    try {
      const res = await app.fetch(new Request('http://localhost/api/vary'))
      expect(
        res.headers
          .get('Vary')!
          .split(',')
          .map((value) => value.trim()),
      ).toContain('Accept')
    } finally {
      await app.close()
    }
  })

  it('headers false remains disabled through application creation', async () => {
    const app = await createApp(
      createDefinition({
        app: defineApp({ headers: false }),
        routes: [
          entry(
            'ping.get.ts',
            route().handler(() => 'ok'),
          ),
        ],
      }),
    )
    try {
      const response = await app.fetch(new Request('http://localhost/api/ping'))
      expect(response.headers.get('X-Content-Type-Options')).toBeNull()
      expect(response.headers.get('X-Frame-Options')).toBeNull()
    } finally {
      await app.close()
    }
  })

  it('406 Not Acceptable preserves existing Vary header and appends Accept', async () => {
    const e = entry(
      'notacceptable.get.ts',
      route({
        middleware: [
          async (ctx: any, next: any) => {
            ctx.header('Vary', 'Accept-Encoding')
            await next()
          },
        ],
      }).handler(() => ({ ok: true })),
    )
    const app = await createApp(createDefinition({ app: defineApp({ csrf: false }), routes: [e] }))
    try {
      const res = await app.fetch(
        new Request('http://localhost/api/notacceptable', {
          headers: { Accept: 'text/html' },
        }),
      )
      expect(res.status).toBe(406)
      const varyTokens = res.headers
        .get('Vary')!
        .split(',')
        .map((t) => t.trim())
      expect(varyTokens).toContain('Accept-Encoding')
      expect(varyTokens).toContain('Accept')
    } finally {
      await app.close()
    }
  })

  it('Range requests bypass delivery-layer compression', async () => {
    const e = entry('/api/range-data', () => ({ data: 'a'.repeat(2000) }))
    const app = await createApp(createDefinition({ app: defineApp(), routes: [e] }))
    const server = await startNodeServer(app, defineNodeRuntime({ port: 0 }))
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/range-data`, {
        headers: {
          'Accept-Encoding': 'gzip',
          Range: 'bytes=0-100',
        },
      })
      expect(res.status).toBe(200)
      expect(res.headers.get('content-encoding')).toBeNull()
    } finally {
      await server.close()
    }
  })
})
