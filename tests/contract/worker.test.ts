import { configureSync, getConfig, type LogRecord, resetSync } from '@logtape/logtape'
import { expect, it, vi } from 'vitest'

import { createWorkerHandler } from '../../src/adapter/cloudflare/runtime'
import { getCurrentScope } from '../../src/core/context'
import { createDefinition } from '../../src/entries/runtime/core'
import { defineApp, route, z } from '../../src/entries/server'
import { parseApiFilePath } from '../../src/http/path'
import type { RouteEntry } from '../../src/http/server/types'

it('shares resolved static configuration between assets and API requests per Worker handler', async () => {
  let reads = 0
  const definition = createDefinition({
    app: defineApp({
      get headers() {
        reads++
        return { 'X-Application': 'shared' }
      },
    }),
    assets: { base: '/assets/', files: { 'main.js': { path: 'main.js', hashed: true } } },
    routes: [
      {
        routePath: parseApiFilePath('ping.get.ts', '/api')!,
        declaration: route().handler(() => ({ ok: true })),
      },
    ],
  })
  const env = { ASSETS: { fetch: async () => new Response('asset') } }
  const context = { waitUntil: vi.fn(), passThroughOnException: vi.fn() }
  const handler = createWorkerHandler(definition)
  expect(reads).toBe(0)
  const asset = await handler.fetch(new Request('https://worker.test/assets/main.js'), env, context)
  expect(await asset.text()).toBe('asset')
  expect(asset.headers.get('X-Application')).toBe('shared')
  const initial = reads
  expect(initial).toBeGreaterThan(0)
  for (const path of ['/api/ping', '/assets/main.js', '/api/ping']) {
    const response = await handler.fetch(new Request('https://worker.test' + path), env, context)
    expect(response.headers.get('X-Application')).toBe('shared')
    if (path === '/api/ping') expect(await response.json()).toEqual({ ok: true })
    else expect(await response.text()).toBe('asset')
    expect(reads).toBe(initial)
  }
  const independent = createWorkerHandler(definition)
  await independent.fetch(new Request('https://worker.test/api/ping'), env, context)
  expect(reads).toBeGreaterThan(initial)
})

it('resolves concurrent event factories once each and reuses their policies during internal dispatch', async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let requests = 0
  const factory = vi.fn((env: { TENANT: string; LIMIT: number }) => ({
    bodyLimit: env.LIMIT,
    csrf: false,
    headers: { 'X-Tenant': env.TENANT },
  }))
  const handler = createWorkerHandler(
    createDefinition({
      app: defineApp(factory),
      routes: [
        {
          routePath: parseApiFilePath('parent.get.ts', '/api')!,
          declaration: route().handler(async () => {
            if (++requests === 2) entered.resolve()
            await release.promise
            const scope = getCurrentScope()!
            const child = await scope.app!.fetchInternal(
              new Request('https://worker.test/api/child', {
                method: 'POST',
                headers: { 'Content-Type': 'text/plain' },
                body: 'four',
              }),
            )
            return {
              childStatus: child.status,
              limit: scope.app!.config.bodyLimit,
              childTenant: child.headers.get('X-Tenant'),
            }
          }),
        },
        {
          routePath: parseApiFilePath('child.post.ts', '/api')!,
          declaration: route()
            .validate({ text: z.string() })
            .handler((_ctx, input) => input.text),
        },
      ],
    }),
  )
  const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() }
  const first = handler.fetch(
    new Request('https://worker.test/api/parent'),
    { TENANT: 'small', LIMIT: 1 },
    ctx,
  )
  const second = handler.fetch(
    new Request('https://worker.test/api/parent'),
    { TENANT: 'large', LIMIT: 8 },
    ctx,
  )
  try {
    await entered.promise
  } finally {
    release.resolve()
  }
  const [small, large] = await Promise.all([first, second])
  expect(small.headers.get('X-Tenant')).toBe('small')
  expect(large.headers.get('X-Tenant')).toBe('large')
  expect(await small.json()).toEqual({ childStatus: 413, limit: 1, childTenant: 'small' })
  expect(await large.json()).toEqual({ childStatus: 200, limit: 8, childTenant: 'large' })
  expect(factory).toHaveBeenCalledTimes(2)
})

it('keeps request metadata and reports configuration failures before routing', async () => {
  const failure = new Error('SECRET is required')
  const handler = createWorkerHandler(
    createDefinition({
      app: defineApp((env: { SECRET?: string }) => {
        if (!env.SECRET) throw failure
        return {}
      }),
      assets: { base: '/assets/', files: { 'main.js': { path: 'main.js', hashed: true } } },
      routes: [
        {
          routePath: parseApiFilePath('ping.get.ts', '/api')!,
          declaration: route().handler(() => ({ ok: true })),
        },
      ],
    }),
  )
  const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() }
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
  try {
    const env = { SECRET: undefined, ASSETS: { fetch: async () => new Response('asset') } }
    for (const [path, method] of [
      ['/api/ping', 'GET'],
      ['/api/ping', 'HEAD'],
      ['/assets/main.js', 'GET'],
      ['/assets/main.js', 'HEAD'],
    ]) {
      const rejected = await handler.fetch(
        new Request('https://worker.example.com' + path, {
          method,
          headers: { 'CF-Ray': 'configuration-failure' },
        }),
        env,
        ctx,
      )
      expect(rejected.status).toBe(500)
      expect(rejected.headers.get('X-Request-Id')).toBe('configuration-failure')
      expect(rejected.headers.get('X-Content-Type-Options')).toBe('nosniff')
      if (method === 'HEAD') expect(await rejected.text()).toBe('')
      else expect((await rejected.json()).error.code).toBe('internal_server_error')
    }
    expect(records).toHaveLength(4)
    for (const record of records) {
      expect(record.properties.requestId).toBe('configuration-failure')
      expect(record.properties.args).toEqual([{ error: failure }])
    }

    const recovered = await handler.fetch(
      new Request('https://worker.example.com/api/ping'),
      { SECRET: 'configured' },
      ctx,
    )
    expect(recovered.status).toBe(200)
    expect(recovered.headers.get('X-Request-Id')).toBeTruthy()
    expect(await recovered.json()).toEqual({ ok: true })
  } finally {
    if (previous) configureSync({ ...previous, reset: true })
    else resetSync()
  }
})

it('dispatches Fetch requests via createWorkerHandler and preserves response payload', async () => {
  const routes: RouteEntry[] = [
    {
      routePath: parseApiFilePath('greeting.get.ts', '/api')!,
      declaration: route().handler(() => ({ message: 'hello from worker' })),
    },
  ]

  const definition = createDefinition({
    app: defineApp({}),
    routes,
  })

  const handler = createWorkerHandler(definition)
  const mockCtx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() }
  const res = await handler.fetch(
    new Request('https://worker.example.com/api/greeting'),
    {},
    mockCtx,
  )

  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ message: 'hello from worker' })
})

it('isolates env and execution context across overlapping Worker invocations', async () => {
  const bothEntered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let entered = 0
  const ctxA = { waitUntil: vi.fn(), passThroughOnException: vi.fn() }
  const ctxB = { waitUntil: vi.fn(), passThroughOnException: vi.fn() }
  const observedContexts = new Map<string, unknown>()
  const handler = createWorkerHandler(
    createDefinition({
      routes: [
        {
          routePath: parseApiFilePath('tenant.get.ts', '/api')!,
          declaration: route().handler(async () => {
            if (++entered === 2) bothEntered.resolve()
            await release.promise
            const scope = getCurrentScope()
            const env = scope?.env as { TENANT: string }
            observedContexts.set(env.TENANT, scope?.executionCtx)
            return { env }
          }),
        },
      ],
    }),
  )
  const reqA = handler.fetch(
    new Request('https://worker.example.com/api/tenant'),
    { TENANT: 'alpha', DB_NAME: 'tenant_alpha_db' },
    ctxA,
  )
  const reqB = handler.fetch(
    new Request('https://worker.example.com/api/tenant'),
    { TENANT: 'beta', DB_NAME: 'tenant_beta_db' },
    ctxB,
  )
  try {
    await bothEntered.promise
  } finally {
    release.resolve()
  }
  const [resA, resB] = await Promise.all([reqA, reqB])
  expect(resA.status).toBe(200)
  expect(resB.status).toBe(200)
  expect(await resA.json()).toEqual({ env: { TENANT: 'alpha', DB_NAME: 'tenant_alpha_db' } })
  expect(await resB.json()).toEqual({ env: { TENANT: 'beta', DB_NAME: 'tenant_beta_db' } })
  expect(observedContexts.get('alpha')).toBe(ctxA)
  expect(observedContexts.get('beta')).toBe(ctxB)
})

it('uses the current event bindings for sequential Worker invocations', async () => {
  const routes: RouteEntry[] = [
    {
      routePath: parseApiFilePath('config.get.ts', '/api')!,
      declaration: route().handler(() => {
        return { env: getCurrentScope()?.env }
      }),
    },
  ]

  const definition = createDefinition({
    app: defineApp({}),
    routes,
  })

  const handler = createWorkerHandler(definition)
  const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() }

  // First request receives env 1
  const res1 = await handler.fetch(
    new Request('https://worker.example.com/api/config'),
    { VERSION: 'v1.0.0' },
    ctx,
  )
  const data1 = await res1.json()
  expect(data1.env).toEqual({ VERSION: 'v1.0.0' })

  // Second request receives env 2
  const res2 = await handler.fetch(
    new Request('https://worker.example.com/api/config'),
    { VERSION: 'v2.0.0' },
    ctx,
  )
  const data2 = await res2.json()
  expect(data2.env).toEqual({ VERSION: 'v2.0.0' })
})

it('extracts platform client IP from cf-connecting-ip and requestId from cf-ray', async () => {
  let observedScope: { clientIp?: string; requestId?: string } | undefined

  const routes: RouteEntry[] = [
    {
      routePath: parseApiFilePath('client.get.ts', '/api')!,
      declaration: route().handler(() => {
        const scope = getCurrentScope()
        observedScope = {
          clientIp: scope?.clientIp,
          requestId: scope?.requestId,
        }
        return { ok: true }
      }),
    },
  ]

  const definition = createDefinition({
    app: defineApp({}),
    routes,
  })

  const handler = createWorkerHandler(definition)
  const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() }

  const res = await handler.fetch(
    new Request('https://worker.example.com/api/client', {
      headers: {
        'cf-connecting-ip': '198.51.100.42',
        'cf-ray': '8c123456789abcde-SJC',
      },
    }),
    {},
    ctx,
  )

  expect(res.status).toBe(200)
  expect(observedScope?.clientIp).toBe('198.51.100.42')
  expect(observedScope?.requestId).toBe('8c123456789abcde-SJC')
  expect(res.headers.get('x-request-id')).toBe('8c123456789abcde-SJC')
})
