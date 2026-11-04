import { describe, expect, it } from 'vitest'

import { getCurrentScope } from '../../src/app/context'
import { createApp, defineApp, route, z } from '../../src/entries/root'
import { createWorkerHandler } from '../../src/entries/runtime/cloudflare'
import { createDefinition } from '../../src/entries/runtime/core'
import { parseApiFilePath } from '../../src/http/path'

describe('Event configuration and assembly', () => {
  it('evaluates Workers factory config into full pipeline: middleware, cors, bodyLimit, and error propagation', async () => {
    interface AppEnv {
      ORIGIN?: string
      REQUIRED_SECRET?: string
    }

    const definition = createDefinition({
      app: defineApp<AppEnv>((env) => {
        if (!env?.REQUIRED_SECRET) {
          throw new Error('REQUIRED_SECRET environment variable is missing')
        }
        return {
          caseSensitive: true,
          bodyLimit: 4,
          csrf: false,
          cors: { origin: env.ORIGIN ?? 'https://default.example' },
          middleware: [
            async (ctx, next) => {
              await next()
              ctx.header('X-App-Middleware', 'yes')
            },
            async (ctx, next) => {
              if (ctx.req.header('x-reject-auth') === 'true') {
                return ctx.json({ error: 'unauthorized' }, 401)
              }
              return next()
            },
          ],
        }
      }),
      routes: [
        {
          routePath: parseApiFilePath('items.get.ts', '/api')!,
          declaration: route().handler(() => ({ items: ['a', 'b'] })),
        },
        {
          routePath: parseApiFilePath('items.post.ts', '/api')!,
          declaration: route()
            .validate({ text: z.string() })
            .handler((_ctx, input) => ({ received: input.text })),
        },
        {
          routePath: parseApiFilePath('subrequest.get.ts', '/api')!,
          declaration: route().handler(async () => {
            const scope = getCurrentScope()
            // Make internal subrequest using app instance
            const subRes = await scope?.app?.fetchInternal(
              new Request('http://localhost/api/items'),
            )
            return {
              subStatus: subRes?.status,
              subMiddlewareHeader: subRes?.headers.get('X-App-Middleware'),
            }
          }),
        },
      ],
    })

    const handler = createWorkerHandler(definition)
    const executionCtx = { waitUntil: () => {}, passThroughOnException: () => {} }

    // Request 1: Valid env with ORIGIN = https://allowed.example
    const req1 = new Request('http://localhost/api/items', {
      headers: { Origin: 'https://allowed.example' },
    })
    const res1 = await handler.fetch(
      req1,
      { ORIGIN: 'https://allowed.example', REQUIRED_SECRET: 'secret-123' },
      executionCtx,
    )
    expect(res1.status).toBe(200)
    expect(res1.headers.get('X-App-Middleware')).toBe('yes')
    expect(res1.headers.get('Access-Control-Allow-Origin')).toBe('https://allowed.example')

    // Request 1b: Middleware short-circuiting with 401 preserves post-middleware headers
    const req1b = new Request('http://localhost/api/items', {
      headers: { 'x-reject-auth': 'true' },
    })
    const res1b = await handler.fetch(
      req1b,
      { ORIGIN: 'https://allowed.example', REQUIRED_SECRET: 'secret-123' },
      executionCtx,
    )
    expect(res1b.status).toBe(401)
    expect(res1b.headers.get('X-App-Middleware')).toBe('yes')
    const errAuth = await res1b.json()
    expect(errAuth).toEqual({ error: 'unauthorized' })

    // Request 1c: caseSensitive in Worker factory takes effect before routing
    const reqUppercase = new Request('http://localhost/API/items', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: '1234',
    })
    const resUppercase = await handler.fetch(
      reqUppercase,
      { ORIGIN: 'https://allowed.example', REQUIRED_SECRET: 'secret-123' },
      executionCtx,
    )
    expect(resUppercase.status).toBe(404)

    // Request 2: POST with 5 bytes (> 4 bytes limit) fails with HTTP 413
    const req2 = new Request('http://localhost/api/items', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: '12345',
    })
    const res2 = await handler.fetch(
      req2,
      { ORIGIN: 'https://allowed.example', REQUIRED_SECRET: 'secret-123' },
      executionCtx,
    )
    expect(res2.status).toBe(413)

    // Request 3: POST with 4 bytes (<= 4 bytes limit) succeeds with HTTP 200
    const req3 = new Request('http://localhost/api/items', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: '1234',
    })
    const res3 = await handler.fetch(
      req3,
      { ORIGIN: 'https://allowed.example', REQUIRED_SECRET: 'secret-123' },
      executionCtx,
    )
    expect(res3.status).toBe(200)
    const data3 = await res3.json()
    expect(data3).toEqual({ received: '1234' })

    // Request 4: A factory failure produces an HTTP 500 error response.
    const req4 = new Request('http://localhost/api/items')
    const res4 = await handler.fetch(req4, {} as AppEnv, executionCtx)
    expect(res4.status).toBe(500)
    const errBody = await res4.json()
    expect(errBody.error?.code).toBe('internal_server_error')

    // Request 5: Subrequest via fetchInternal inherits ambient event config without re-running factory
    const req5 = new Request('http://localhost/api/subrequest')
    const res5 = await handler.fetch(
      req5,
      { ORIGIN: 'https://allowed.example', REQUIRED_SECRET: 'secret-123' },
      executionCtx,
    )
    expect(res5.status).toBe(200)
    const data5 = await res5.json()
    expect(data5.subStatus).toBe(200)
    expect(data5.subMiddlewareHeader).toBe('yes')
  })

  it('does not execute the CORS origin callback multiple times on overlapping routes', async () => {
    let corsOriginCalls = 0
    const definition = createDefinition({
      app: defineApp({
        cors: {
          origin: (origin) => {
            corsOriginCalls++
            return origin
          },
        },
      }),
      routes: [
        {
          routePath: parseApiFilePath('users/me.get.ts', '/api')!,
          declaration: route().handler(() => ({ user: 'me' })),
        },
        {
          routePath: parseApiFilePath('users/[id].get.ts', '/api')!,
          declaration: route()
            .validate({ params: z.object({ id: z.string() }) })
            .handler((_c, input) => ({ user: input.params.id })),
        },
      ],
    })

    const app = await createApp(definition)
    try {
      const res = await app.fetch(
        new Request('http://localhost/api/users/me', {
          headers: { Origin: 'https://client.example' },
        }),
      )

      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data).toEqual({ user: 'me' })
      expect(corsOriginCalls).toBe(1)
    } finally {
      await app.close()
    }
  })

  it('evaluates dynamic defineApp factory per-request and forwards env in fetchInternal', async () => {
    let factoryCalls = 0
    const definition = createDefinition({
      app: defineApp((env: { RELEASE?: string; SECRET?: string }) => {
        factoryCalls++
        return {
          headers: {
            'X-Release': env.RELEASE || 'default-release',
          },
        }
      }),
      routes: [
        {
          routePath: parseApiFilePath('parent.get.ts', '/api')!,
          declaration: route().handler(async () => {
            const app = getCurrentScope()?.app
            const childRes = await app!.fetchInternal(new Request('http://worker.local/api/child'))
            const childData = (await childRes.json()) as { secret: string }
            return {
              childSecret: childData.secret,
            }
          }),
        },
        {
          routePath: parseApiFilePath('child.get.ts', '/api')!,
          declaration: route().handler((ctx) => {
            return { secret: (ctx.env as { SECRET?: string })?.SECRET || 'no-secret' }
          }),
        },
      ],
    })

    const handler = createWorkerHandler(definition)
    const mockCtx = {
      waitUntil: () => {},
      passThroughOnException: () => {},
    }

    // First request with env: RELEASE=one, SECRET=alpha
    const req1 = new Request('http://worker.local/api/parent')
    const res1 = await handler.fetch(req1, { RELEASE: 'one', SECRET: 'alpha' }, mockCtx)
    expect(res1.status).toBe(200)
    expect(res1.headers.get('X-Release')).toBe('one')
    const body1 = (await res1.json()) as { childSecret: string }
    expect(body1.childSecret).toBe('alpha')

    // Second request with env: RELEASE=two, SECRET=beta
    const req2 = new Request('http://worker.local/api/parent')
    const res2 = await handler.fetch(req2, { RELEASE: 'two', SECRET: 'beta' }, mockCtx)
    expect(res2.status).toBe(200)
    expect(res2.headers.get('X-Release')).toBe('two')
    const body2 = (await res2.json()) as { childSecret: string }
    expect(body2.childSecret).toBe('beta')
    expect(factoryCalls).toBe(2)
  })
})
