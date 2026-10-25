import { configureSync, getConfig, type LogRecord, resetSync } from '@logtape/logtape'
import { expect, it } from 'vitest'

import { createClient } from '../../src/entries/http'
import { createDefinition } from '../../src/entries/runtime/core'
import { startNodeServer } from '../../src/entries/runtime/node'
import { createApp, HttpError, route, z } from '../../src/entries/server'
import { defineNodeRuntime } from '../../src/entries/server/node'
import { parseApiFilePath } from '../../src/web/http/path'
import type { RouteEntry } from '../../src/web/http/server/pipeline'
import type { RouteDeclaration } from '../../src/web/http/types'

function entry(source: string, declaration: RouteDeclaration, prefix = '/api'): RouteEntry {
  return { source, routePath: parseApiFilePath(source, prefix)!, declaration }
}

it.each(['GET', 'HEAD', 'POST'])(
  'normalizes only the winning %s route without changing parameter values',
  async (method) => {
    const app = await createApp(
      createDefinition({
        routes: [
          entry(
            'files.README.put.ts',
            route().handler(() => ({ fixed: true })),
          ),
          entry(
            'files.[name].all.ts',
            route().handler((ctx) => ({ name: ctx.req.param('name') })),
          ),
          entry(
            'files.[name].get.ts',
            route().handler((ctx) => ({ name: ctx.req.param('name') })),
          ),
        ],
      }),
    )
    try {
      const unchanged = await app.fetch(
        new Request('https://example.test/api/files/ReadMe', {
          method,
          headers: { Origin: 'https://example.test' },
        }),
      )
      expect(unchanged.status).toBe(200)
      if (method !== 'HEAD') expect(await unchanged.json()).toEqual({ name: 'ReadMe' })
      const changed = await app.fetch(
        new Request('https://example.test/API/FILES/ReadMe', {
          method,
          headers: { Origin: 'https://example.test' },
        }),
      )
      if (method === 'POST') {
        expect(changed.status).toBe(200)
        expect(await changed.json()).toEqual({ name: 'ReadMe' })
      } else {
        expect(changed.status).toBe(308)
        expect(changed.headers.get('Location')).toBe('https://example.test/api/files/ReadMe')
      }
    } finally {
      await app.close()
    }
  },
)

it('substitutes complete parameter names independently of property order', async () => {
  const app = await createApp(
    createDefinition({
      routes: [
        entry(
          'groups.[identifier].items.[id].get.ts',
          route().handler((ctx) => ctx.req.param()),
        ),
      ],
    }),
  )
  try {
    const client = createClient({ baseUrl: 'https://example.test/api', fetch: app.fetch })
    expect(
      await client.get('/groups/:identifier/items/:id', { params: { id: 42, identifier: 'team' } }),
    ).toEqual({ identifier: 'team', id: '42' })
  } finally {
    await app.close()
  }
})

it('normalizes preflight paths using the requested method and preserves its parameter context', async () => {
  const app = await createApp(
    createDefinition({
      routes: [
        entry(
          'files.README.put.ts',
          route().handler(() => ({ fixed: true })),
        ),
        entry(
          'files.[name].get.ts',
          route({
            cors: {
              origin: (origin, ctx) => (ctx.req.param('name') === 'ReadMe' ? origin : ''),
            },
          }).handler(() => ({ ok: true })),
        ),
      ],
    }),
  )
  try {
    const response = await app.fetch(
      new Request('https://example.test/API/FILES/ReadMe', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://frontend.example',
          'Access-Control-Request-Method': 'GET',
        },
      }),
    )
    expect(response.status).toBe(204)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://frontend.example')
  } finally {
    await app.close()
  }
})

it('carries named catch-all values from discovered paths through encoding, Hono and validation', async () => {
  const routePath = parseApiFilePath('files.[...path].get.ts', '/api')!
  const app = await createApp(
    createDefinition({
      routes: [
        {
          routePath,
          declaration: route()
            .validate({ params: z.object({ path: z.string().optional() }) })
            .handler((ctx, input) => ({ path: input.params.path, raw: ctx.req.param('path') })),
        },
      ],
    }),
  )
  try {
    const client = createClient({ baseUrl: 'https://example.test/api', fetch: app.fetch })
    for (const path of ['guide/setup', '中文/a b?#%.txt']) {
      expect(
        await client.get(routePath.clientPath.slice('/api'.length), { params: { path } }),
      ).toEqual({ path, raw: path })
    }
    const base = await app.fetch(new Request('https://example.test/api/files'))
    expect(base.status).toBe(200)
    expect(await base.json()).toEqual({})
  } finally {
    await app.close()
  }
})

it.each([401, 404, 500])(
  'retains status and response headers for a bodyless HEAD %s',
  async (status) => {
    const app = await createApp(
      createDefinition({
        routes: [
          entry(
            'private.get.ts',
            route().handler(() => {
              throw new HttpError(status, 'Rejected', { headers: { 'WWW-Authenticate': 'Bearer' } })
            }),
          ),
        ],
      }),
    )
    try {
      const client = createClient({ baseUrl: 'https://example.test/api', fetch: app.fetch })
      await expect(client.head('/private')).rejects.toMatchObject({
        status,
        code: 'http_error',
        headers: expect.any(Headers),
      })
      try {
        await client.head('/private')
      } catch (error) {
        expect(error).toBeInstanceOf(HttpError)
        expect((error as HttpError).headers.get('WWW-Authenticate')).toBe('Bearer')
      }
    } finally {
      await app.close()
    }
  },
)

it('rejects an enabled probe collision before listening and releases the application', async () => {
  const app = await createApp(
    createDefinition({
      routes: [
        entry(
          'readyz.get.ts',
          route().handler(() => ({ business: true })),
          '/',
        ),
      ],
    }),
  )
  try {
    await expect(startNodeServer(app, defineNodeRuntime({ port: 0 }))).rejects.toThrow(
      /readiness.*readyz.get.ts/,
    )
    expect(app.state).toBe('closed')
  } finally {
    await app.close()
  }
})

it('permits the same probe path for another method or when probes are disabled', async () => {
  for (const { probes, method } of [
    { probes: false, method: 'GET' },
    { probes: { liveness: '/livez', readiness: '/readyz' }, method: 'POST' },
  ] as const) {
    const app = await createApp(
      createDefinition({
        routes: [
          entry(
            `readyz.${method.toLowerCase()}.ts`,
            route().handler(() => ({ business: true })),
            '/',
          ),
        ],
      }),
    )
    const host = await startNodeServer(
      app,
      defineNodeRuntime({ port: 0, hostname: '127.0.0.1', probes }),
    )
    try {
      const response = await fetch(`http://127.0.0.1:${host.port}/readyz`, {
        method,
        headers: { Origin: `http://127.0.0.1:${host.port}` },
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ business: true })
    } finally {
      await host.close()
    }
  }
})

it('exposes request identity to handlers and records correlated framework errors through LogTape', async () => {
  const previous = getConfig()
  const records: LogRecord[] = []
  configureSync({
    reset: true,
    sinks: { capture: (record) => records.push(record) },
    loggers: [
      { category: ['app'], lowestLevel: 'error', sinks: ['capture'] },
      { category: ['logtape', 'meta'], lowestLevel: 'error', sinks: [] },
    ],
  })
  const failure = new Error('operation failed')
  const app = await createApp(
    createDefinition({
      routes: [
        entry(
          'context.get.ts',
          route().handler((ctx) => ({ id: ctx.var.requestId })),
        ),
        entry(
          'failure.get.ts',
          route().handler(() => {
            throw failure
          }),
        ),
      ],
    }),
  )
  try {
    const response = await app.fetch(new Request('https://example.test/api/context'))
    const id = response.headers.get('X-Request-Id')
    expect(id).toBeTruthy()
    expect(await response.json()).toEqual({ id })
    const rejected = await app.fetch(new Request('https://example.test/api/failure'))
    expect(rejected.status).toBe(500)
    expect(records).toHaveLength(1)
    expect(records[0].message.join('')).toContain(rejected.headers.get('X-Request-Id'))
    expect(records[0].properties.args).toEqual([{ error: failure }])
  } finally {
    await app.close()
    if (previous) configureSync({ ...previous, reset: true })
    else resetSync()
  }
})
