import type { Context, Next } from 'hono'
import { expect, it } from 'vitest'

import { createDefinition } from '../../src/entries/runtime/core'
import {
  type AppConfig,
  type AppInstance,
  createApp,
  defineApp,
  route,
  z,
} from '../../src/entries/server'
import { parseApiFilePath } from '../../src/http/path'
import type { RouteEntry } from '../../src/http/server/types'
import type { RouteScope } from '../../src/http/types'

async function withApp(
  config: AppConfig,
  routes: RouteEntry[],
  run: (app: AppInstance) => Promise<void>,
) {
  const app = await createApp(createDefinition({ app: defineApp(config), routes }))
  try {
    await run(app)
  } finally {
    await app.close()
  }
}

it('executes ancestor middlewares and route middleware in outside-in order', async () => {
  const callOrder: string[] = []

  const rootScope: RouteScope = {
    middleware: async (ctx: Context, next: Next) => {
      callOrder.push('root')
      ctx.header('X-Track-Root', '1')
      await next()
    },
  }

  const usersScope: RouteScope = {
    middleware: async (ctx: Context, next: Next) => {
      callOrder.push('users')
      ctx.header('X-Track-Users', '1')
      await next()
    },
  }

  const routeHandler = route({
    middleware: [
      async (ctx: Context, next: Next) => {
        callOrder.push('route')
        ctx.header('X-Track-Route', '1')
        await next()
      },
    ],
  }).handler((_ctx) => {
    callOrder.push('handler')
    return { ok: true }
  })

  const routes: RouteEntry[] = [
    {
      routePath: parseApiFilePath('users/profile.get.ts', '/api')!,
      declaration: routeHandler,
      scopes: [rootScope, usersScope],
    },
  ]

  await withApp({}, routes, async (app) => {
    const res = await app.fetch(new Request('http://localhost/api/users/profile'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(callOrder).toEqual(['root', 'users', 'route', 'handler'])
    expect(res.headers.get('X-Track-Root')).toBe('1')
    expect(res.headers.get('X-Track-Users')).toBe('1')
    expect(res.headers.get('X-Track-Route')).toBe('1')
  })
})

it('cascades policies through appConfig -> ancestor scopes -> route options', async () => {
  const restrictedScope: RouteScope = {
    options: {
      bodyLimit: 50,
      cors: { origin: 'https://scoped.example' },
    },
  }

  const routes: RouteEntry[] = [
    {
      routePath: parseApiFilePath('public/item.post.ts', '/api')!,
      declaration: route()
        .validate({ json: z.object({ value: z.string() }) })
        .handler((_ctx, input) => input.json),
    },
    {
      routePath: parseApiFilePath('scoped/small.post.ts', '/api')!,
      declaration: route()
        .validate({ json: z.object({ value: z.string() }) })
        .handler((_ctx, input) => input.json),
      scopes: [restrictedScope],
    },
    {
      routePath: parseApiFilePath('scoped/override.post.ts', '/api')!,
      declaration: route({
        bodyLimit: 500,
        cors: { origin: 'https://override.example' },
      })
        .validate({ json: z.object({ value: z.string() }) })
        .handler((_ctx, input) => input.json),
      scopes: [restrictedScope],
    },
  ]

  await withApp(
    {
      bodyLimit: 200,
      cors: { origin: 'https://app.example' },
    },
    routes,
    async (app) => {
      // 1. Unscoped route respects app-level limit of 200 bytes (payload ~ 80 bytes passes)
      const bigPayload = JSON.stringify({ value: 'x'.repeat(70) })
      const publicRes = await app.fetch(
        new Request('http://localhost/api/public/item', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: 'https://app.example' },
          body: bigPayload,
        }),
      )
      expect(publicRes.status).toBe(200)
      expect(publicRes.headers.get('Access-Control-Allow-Origin')).toBe('https://app.example')

      // 2. Scoped route cascades bodyLimit: 50 bytes from restrictedScope, rejecting the 80 bytes payload
      const scopedRes = await app.fetch(
        new Request('http://localhost/api/scoped/small', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: 'https://scoped.example' },
          body: bigPayload,
        }),
      )
      expect(scopedRes.status).toBe(413)
      expect(scopedRes.headers.get('Access-Control-Allow-Origin')).toBe('https://scoped.example')

      // 3. Route override expands limit to 500 bytes and overrides CORS origin
      const overrideRes = await app.fetch(
        new Request('http://localhost/api/scoped/override', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: 'https://override.example' },
          body: bigPayload,
        }),
      )
      expect(overrideRes.status).toBe(200)
      expect(overrideRes.headers.get('Access-Control-Allow-Origin')).toBe(
        'https://override.example',
      )
    },
  )
})

it('allows directory scope to disable CSRF check for a subtree', async () => {
  const exemptScope: RouteScope = {
    options: {
      csrf: false,
    },
  }

  const routes: RouteEntry[] = [
    {
      routePath: parseApiFilePath('webhook/incoming.post.ts', '/api')!,
      declaration: route().handler(() => ({ received: true })),
      scopes: [exemptScope],
    },
    {
      routePath: parseApiFilePath('standard/submit.post.ts', '/api')!,
      declaration: route().handler(() => ({ received: true })),
    },
  ]

  await withApp(
    {
      csrf: true,
    },
    routes,
    async (app) => {
      // Webhook route has csrf: false from its scope; form POST without Origin passes
      const webhookRes = await app.fetch(
        new Request('http://localhost/api/webhook/incoming', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'foo=bar',
        }),
      )
      expect(webhookRes.status).toBe(200)

      // Standard route enforces CSRF; form POST without Origin fails with 403 csrf_forbidden
      const standardRes = await app.fetch(
        new Request('http://localhost/api/standard/submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'foo=bar',
        }),
      )
      expect(standardRes.status).toBe(403)
      const err = await standardRes.json()
      expect(err.error.code).toBe('csrf_forbidden')
    },
  )
})

it('preserves Set-Cookie headers across multi-level directory middlewares and handler', async () => {
  const rootScope: RouteScope = {
    middleware: async (ctx: Context, next: Next) => {
      ctx.header('Set-Cookie', 'scope_root=1; Path=/; HttpOnly', { append: true })
      await next()
    },
  }

  const childScope: RouteScope = {
    middleware: async (ctx: Context, next: Next) => {
      ctx.header('Set-Cookie', 'scope_child=2; Path=/; Secure', { append: true })
      await next()
    },
  }

  const routes: RouteEntry[] = [
    {
      routePath: parseApiFilePath('auth/session.post.ts', '/api')!,
      declaration: route().handler((ctx) => {
        ctx.header('Set-Cookie', 'session=3; Path=/', { append: true })
        return { ok: true }
      }),
      scopes: [rootScope, childScope],
    },
  ]

  await withApp({}, routes, async (app) => {
    const res = await app.fetch(
      new Request('http://localhost/api/auth/session', {
        method: 'POST',
        headers: { 'Sec-Fetch-Site': 'same-origin' },
      }),
    )
    expect(res.status).toBe(200)
    const cookies = res.headers.getSetCookie()
    expect(cookies).toHaveLength(3)
    expect(cookies).toContain('scope_root=1; Path=/; HttpOnly')
    expect(cookies).toContain('scope_child=2; Path=/; Secure')
    expect(cookies).toContain('session=3; Path=/')
  })
})

it('preserves ancestor Set-Cookie headers when handler returns explicit Response', async () => {
  const rootScope: RouteScope = {
    middleware: async (ctx: Context, next: Next) => {
      ctx.header('Set-Cookie', 'scope_ancestor=1; Path=/', { append: true })
      await next()
    },
  }

  const routes: RouteEntry[] = [
    {
      routePath: parseApiFilePath('explicit/download.get.ts', '/api')!,
      declaration: route().handler(() => {
        return new Response('file content', {
          headers: {
            'Content-Type': 'text/plain',
            'Set-Cookie': 'explicit_handler=2; Path=/',
          },
        })
      }),
      scopes: [rootScope],
    },
  ]

  await withApp({}, routes, async (app) => {
    const res = await app.fetch(new Request('http://localhost/api/explicit/download'))
    expect(res.status).toBe(200)
    const cookies = res.headers.getSetCookie()
    expect(cookies).toHaveLength(2)
    expect(cookies).toContain('scope_ancestor=1; Path=/')
    expect(cookies).toContain('explicit_handler=2; Path=/')
  })
})
