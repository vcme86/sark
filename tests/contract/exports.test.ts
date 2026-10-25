import { describe, expect, it } from 'vitest'

import { parseApiFilePath } from '../../src/web/http/path'

describe('Contract: Built Package Exports', () => {
  it('imports @olivaw/sark/server from build output', async () => {
    const server = await import('@olivaw/sark/server')
    expect(server.createApp).toBeDefined()
    expect(server.defineApp).toBeDefined()
    expect(server.route).toBeDefined()
    expect(server.HttpError).toBeDefined()
    expect(server.dedup).toBeDefined()
    expect(server.getLogger).toBeDefined()
    expect(server.z).toBeDefined()
    expect(server.getCookie).toBeDefined()
    expect(server.setCookie).toBeDefined()
  })

  it('imports @olivaw/sark/http from build output', async () => {
    const http = await import('@olivaw/sark/http')
    expect(http.createClient).toBeDefined()
    expect(http.HttpError).toBeDefined()

    const client = http.createClient({ baseUrl: 'http://localhost:3000/api' })
    expect(client.get).toBeDefined()
    expect(client.post).toBeDefined()
    expect(client.requestRaw).toBeDefined()
  })

  it('imports @olivaw/sark/utils from build output', async () => {
    const utils = await import('@olivaw/sark/utils')
    expect(utils.parseCookie).toBeDefined()
    expect(utils.serializeCookie).toBeDefined()

    const parsed = utils.parseCookie('session=abc; theme=dark')
    expect(parsed.session).toBe('abc')
    expect(parsed.theme).toBe('dark')
  })

  it('executes public middleware and Node runtime entries through HTTP', async () => {
    const [
      { createApp, defineApp, route },
      { createDefinition },
      { startNodeServer },
      { defineNodeRuntime },
      { cors, csrf, compress },
    ] = await Promise.all([
      import('@olivaw/sark/server'),
      import('@olivaw/sark/runtime/core'),
      import('@olivaw/sark/runtime/node'),
      import('@olivaw/sark/server/node'),
      import('@olivaw/sark/middleware'),
    ])
    const payload = { value: 'A'.repeat(5000) }
    const instance = await createApp(
      createDefinition({
        app: defineApp({
          csrf: false,
          middleware: [
            cors({ origin: 'https://frontend.example' }),
            csrf({ origins: ['https://frontend.example'] }),
            compress({ threshold: 0 }),
          ],
        }),
        routes: [
          {
            routePath: parseApiFilePath('ping.all.ts', '/api')!,
            declaration: route().handler(() => payload),
          },
        ],
      }),
    )
    const host = await startNodeServer(
      instance,
      defineNodeRuntime({
        port: 0,
        hostname: '127.0.0.1',
        probes: false,
        compress: false,
      }),
    )
    try {
      const url = `http://127.0.0.1:${host.port}/api/ping`
      const response = await fetch(url, {
        headers: {
          Origin: 'https://frontend.example',
          'Accept-Encoding': 'gzip',
        },
      })
      expect(response.status).toBe(200)
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://frontend.example')
      expect(response.headers.get('Content-Encoding')).toBe('gzip')
      expect(await response.json()).toEqual(payload)
      const rejected = await fetch(url, {
        method: 'POST',
        body: 'hello',
        headers: {
          Origin: 'https://other.example',
          'Content-Type': 'text/plain',
        },
      })
      expect(rejected.status).toBe(403)
      expect((await rejected.json()).error.code).toBe('csrf_forbidden')
    } finally {
      await host.close()
    }
  })

  it('imports @olivaw/sark/runtime/core from build output', async () => {
    const runtimeCore = await import('@olivaw/sark/runtime/core')
    expect(runtimeCore.createDefinition).toBeDefined()
  })

  it('imports @olivaw/sark/runtime/node from build output', async () => {
    const runtimeNode = await import('@olivaw/sark/runtime/node')
    expect(Object.keys(runtimeNode).toSorted()).toEqual(['loadNodeEnv', 'startNodeServer'])
  })

  it('imports @olivaw/sark/vite from build output', async () => {
    const vite = await import('@olivaw/sark/vite')
    expect(vite.sark).toBeDefined()
    const plugin = vite.sark({ target: 'node' })
    expect(plugin.name).toBe('@olivaw/sark')
  })
})
