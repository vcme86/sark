import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { getCurrentScope } from '../../src/core/context'
import { createWorkerHandler } from '../../src/entries/runtime/cloudflare'
import { createDefinition } from '../../src/entries/runtime/core'
import { createApp, defineApp, route, z } from '../../src/entries/server'
import { discoverApiRoutes } from '../../src/tooling/build/discover/routes'
import { generateBuildArtifacts } from '../../src/tooling/build/generate'
import { parseApiFilePath } from '../../src/web/http/path'

function withTempProject(fn: (projectDir: string) => Promise<void> | void): Promise<void> {
  mkdirSync('.build', { recursive: true })
  const dir = mkdtempSync(resolve('.build/review14-'))
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => {
      rmSync(dir, { recursive: true, force: true })
    })
}

describe('Application configuration and generated assembly regressions', () => {
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

  it('cleans up opposing target entry files upon switching between node and cloudflare targets', async () => {
    await withTempProject((root) => {
      const generatedDir = join(root, '.build')

      // Step A: Generate for Node
      generateBuildArtifacts({
        generatedDir,
        appEntryPath: join(root, 'app.ts'),
        appExports: { hasApp: true, hasRuntime: false, exports: ['app'] },
        routes: [],
        apiPrefix: '/api',
        webPrefix: '/',
        target: 'node',
      })
      expect(existsSync(join(generatedDir, 'start.ts'))).toBe(true)
      expect(existsSync(join(generatedDir, 'worker.ts'))).toBe(false)

      // Step B: Switch to Cloudflare in same project
      generateBuildArtifacts({
        generatedDir,
        appEntryPath: join(root, 'app.ts'),
        appExports: { hasApp: true, hasRuntime: false, exports: ['app'] },
        routes: [],
        apiPrefix: '/api',
        webPrefix: '/',
        target: 'cloudflare',
      })
      expect(existsSync(join(generatedDir, 'worker.ts'))).toBe(true)
      expect(existsSync(join(generatedDir, 'start.ts'))).toBe(false)

      // Step C: Switch back to Node in same project
      generateBuildArtifacts({
        generatedDir,
        appEntryPath: join(root, 'app.ts'),
        appExports: { hasApp: true, hasRuntime: false, exports: ['app'] },
        routes: [],
        apiPrefix: '/api',
        webPrefix: '/',
        target: 'node',
      })
      expect(existsSync(join(generatedDir, 'start.ts'))).toBe(true)
      expect(existsSync(join(generatedDir, 'worker.ts'))).toBe(false)
    })
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

  it('discovers ancestor middlewares for api/users/_middleware.ts and omits .scope when absent', async () => {
    await withTempProject((root) => {
      const apiDir = join(root, 'api')
      mkdirSync(join(apiDir, 'users'), { recursive: true })

      // A default-only middleware must not require a named scope export.
      writeFileSync(
        join(apiDir, 'users/_middleware.ts'),
        `import { createMiddleware } from 'hono/factory'
export default createMiddleware(async (c, next) => {
  c.header('X-Users-Scope', 'true')
  return next()
})
`,
      )

      writeFileSync(
        join(apiDir, 'users/get.ts'),
        `import { route } from '@olivaw/sark/server'
export default route().handler(() => ({ users: [] }))
`,
      )

      const routes = discoverApiRoutes(apiDir, '/api')
      expect(routes.length).toBe(1)
      const userRoute = routes[0]
      expect(userRoute.routePath.urlPath).toBe('/api/users')
      // 1. The method-only route inherits middleware from its directory.
      expect(userRoute.ancestorMiddlewares.length).toBe(1)
      expect(userRoute.ancestorMiddlewares[0].scopeKey).toBe('users')
      expect(userRoute.ancestorMiddlewares[0].hasScope).toBe(false)
      expect(userRoute.ancestorMiddlewares[0].hasDefault).toBe(true)

      // 2. Generated code imports only the middleware exports that exist.
      const generatedDir = join(root, '.build')
      generateBuildArtifacts({
        generatedDir,
        appEntryPath: join(root, 'app.ts'),
        appExports: { hasApp: false, hasRuntime: false, exports: [] },
        routes,
        apiPrefix: '/api',
        webPrefix: '/',
        target: 'node',
      })

      const appTs = readFileSync(join(generatedDir, 'app.ts'), 'utf-8')
      expect(appTs).toContain('{ middleware: middleware_0.default }')
      expect(appTs).not.toContain('middleware_0.scope')
    })
  })
})
