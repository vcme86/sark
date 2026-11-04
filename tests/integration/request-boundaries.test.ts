import { expect, it } from 'vitest'

import { defineNodeRuntime } from '../../src/entries/node'
import { createApp, defineApp, route } from '../../src/entries/root'
import { createDefinition } from '../../src/entries/runtime/core'
import { startNodeServer } from '../../src/entries/runtime/node'
import { parseApiFilePath } from '../../src/http/path'

it.each(['/api/ping', '/livez', '/readyz'])(
  'preserves common error handling for a rejected Host on %s',
  async (path) => {
    const app = await createApp(
      createDefinition({
        app: defineApp({ hosts: ['allowed.test'] }),
        routes: [
          {
            routePath: parseApiFilePath('ping.get.ts', '/api')!,
            declaration: route().handler(() => ({ ok: true })),
          },
        ],
      }),
    )
    const host = await startNodeServer(app, defineNodeRuntime({ port: 0, hostname: '127.0.0.1' }))
    try {
      for (const method of ['GET', 'HEAD']) {
        const response = await fetch(`http://127.0.0.1:${host.port}${path}`, { method })
        expect(response.status).toBe(400)
        expect(response.headers.get('X-Request-Id')).toBeTruthy()
        expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
        if (method === 'HEAD') expect(await response.text()).toBe('')
        else expect((await response.json()).error.code).toBe('invalid_host')
      }
    } finally {
      await host.close()
    }
  },
)

it.each([true, false])(
  'uses forwarding metadata only from a trusted Node peer (trusted=%s)',
  async (trusted) => {
    const app = await createApp(
      createDefinition({
        app: defineApp({ trustedProxies: trusted ? ['loopback'] : [] }),
        routes: [
          {
            routePath: parseApiFilePath('ping.get.ts', '/api')!,
            declaration: route().handler((ctx) => ({ id: ctx.var.requestId })),
          },
        ],
      }),
    )
    const host = await startNodeServer(app, defineNodeRuntime({ port: 0, hostname: '127.0.0.1' }))
    try {
      const origin = `http://127.0.0.1:${host.port}`
      const headers = {
        'X-Forwarded-Proto': 'https',
        'X-Forwarded-Host': 'public.example',
        'X-Request-Id': 'proxy-request-id',
        'CF-Ray': 'client-supplied-ray',
      }
      const response = await fetch(`${origin}/api/ping`, { headers })
      const id = response.headers.get('X-Request-Id')
      expect(id).toBeTruthy()
      expect(await response.json()).toEqual({ id })
      if (trusted) expect(id).toBe('proxy-request-id')
      else {
        expect(id).not.toBe('proxy-request-id')
        expect(id).not.toBe('client-supplied-ray')
      }
      const redirect = await fetch(`${origin}/api/ping/?q=book`, { headers, redirect: 'manual' })
      expect(redirect.status).toBe(308)
      expect(redirect.headers.get('Location')).toBe(
        `${trusted ? 'https://public.example' : origin}/api/ping?q=book`,
      )
    } finally {
      await host.close()
    }
  },
)

it('records native public deliveries and accepted WebSocket handshakes once without business bindings on files or probes', async () => {
  const { once } = await import('node:events')
  const { WebSocket } = await import('ws')
  const { createProject } = await import('../helpers/project')
  const { createLoggingAssembly } = await import('../../src/features/logging/assembly')
  const { defineLogging } = await import('../../src/features/logging/declaration')
  const records: import('@logtape/logtape').LogRecord[] = []
  let bindings = 0
  const project = createProject()
  project.write('public/file.txt', 'public file')
  const app = await createApp(
    createDefinition({
      app: defineApp({ cors: { origin: 'https://consumer.test' }, trustedProxies: ['loopback'] }),
      logging: createLoggingAssembly(
        defineLogging({
          access: ['collector'],
          sinks: {
            collector: () => (record) => {
              records.push(record)
            },
          },
        }),
      ),
      services: {
        counted: {
          createRuntime: () => ({
            prepare: () => ({
              create: () => ({
                createBinding() {
                  bindings++
                  return {}
                },
              }),
            }),
          }),
        },
      },
      routes: [
        {
          routePath: parseApiFilePath('socket.ws.ts', '/api')!,
          declaration: route().handler(() => ({})),
        },
      ],
    }),
  )
  const host = await startNodeServer(
    app,
    defineNodeRuntime({ port: 0, hostname: '127.0.0.1' }),
    undefined,
    {
      rootDir: project.root,
      assets: { base: '/', files: { 'file.txt': { path: 'public/file.txt', hashed: false } } },
    },
  )
  try {
    for (const path of ['/file.txt', '/livez', '/readyz']) {
      const response = await fetch(`http://127.0.0.1:${host.port}${path}`, {
        headers: {
          origin: 'https://consumer.test',
          'x-request-id': path,
          'x-forwarded-for': '198.51.100.12',
        },
      })
      expect(response.status).toBe(200)
      expect(response.headers.get('X-Request-Id')).toBe(path)
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://consumer.test')
      await response.text()
    }
    expect(bindings).toBe(0)
    const { request: nativeRequest } = await import('node:http')
    const rejected = await new Promise<number | undefined>((resolve, reject) => {
      const request = nativeRequest(
        `http://127.0.0.1:${host.port}/api/socket`,
        {
          headers: {
            origin: `http://127.0.0.1:${host.port}`,
            connection: 'Upgrade',
            upgrade: 'websocket',
            'sec-websocket-version': '12',
            'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
            'x-request-id': 'refused-ws',
            'x-forwarded-for': '198.51.100.12',
          },
        },
        (response) => {
          response.resume()
          response.on('end', () => resolve(response.statusCode))
        },
      )
      request.on('error', reject)
      request.end()
    })
    expect(rejected).toBe(400)
    const socket = new WebSocket(`ws://127.0.0.1:${host.port}/api/socket`, {
      headers: {
        origin: `http://127.0.0.1:${host.port}`,
        'x-request-id': 'accepted-ws',
        'x-forwarded-for': '198.51.100.12',
      },
    })
    await once(socket, 'open')
    const closed = once(socket, 'close')
    socket.close()
    await closed
    await expect
      .poll(() => records.filter((record) => record.category.join('/') === 'sark/access').length)
      .toBe(5)
    const access = records.filter((record) => record.category.join('/') === 'sark/access')
    expect(access.map((record) => record.properties.status)).toEqual([
      200,
      200,
      200,
      undefined,
      101,
    ])
    expect(access.every((record) => record.properties.clientIp === '198.51.100.12')).toBe(true)
    expect(access.filter((record) => record.properties.requestId === 'accepted-ws')).toHaveLength(1)
    const refused = access.filter((record) => record.properties.requestId === 'refused-ws')
    expect(refused).toHaveLength(1)
    expect(refused[0].properties).toMatchObject({ outcome: 'error' })
    expect(bindings).toBe(2)
  } finally {
    await host.close()
    project.remove()
  }
})
