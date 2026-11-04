import { generateSignedCookie } from 'hono/cookie'
import { describe, expect, it } from 'vitest'

import { getCurrentScope } from '../../src/app/context'
import { createApp } from '../../src/app/create'
import { createDefinition } from '../../src/app/definition'
import type { AppInstance } from '../../src/app/types'
import { defineAuth, type RequestAuth } from '../../src/entries/auth'
import { defineApp, route } from '../../src/entries/root'
import { createAuthAssembly } from '../../src/entries/runtime/auth'
import { createWorkerHandler } from '../../src/entries/runtime/cloudflare'
import { createVisitorsAssembly } from '../../src/entries/runtime/visitors'
import { defineVisitors, type RequestVisitor, VisitorError } from '../../src/entries/visitors'
import { parseApiFilePath } from '../../src/http/path'

function getVisitor(ctx: any): RequestVisitor {
  return ctx.var.visitor
}

function getAuth(ctx: any): RequestAuth {
  return ctx.var.auth
}

const SECRET = 'test-visitor-signing-secret-at-least-32-chars!'
const AUTH_SECRET = 'test-auth-signing-secret-at-least-32-characters!'

describe('Visitors Contract Tests', () => {
  it.each([1_000, 34_560_000_000])(
    'initializes with a supported lifetime of %s milliseconds',
    async (expiresIn) => {
      const instance = await createApp(
        createDefinition({
          app: defineApp({}),
          services: {
            visitors: createVisitorsAssembly(defineVisitors({ secret: SECRET, expiresIn })),
          },
        }),
      )
      try {
        const response = await instance.fetch(
          new Request('http://localhost/__sark/visitor', {
            method: 'POST',
            headers: { Origin: 'http://localhost' },
          }),
        )
        expect(response.status).toBe(204)
        expect(await response.text()).toBe('')
        expect(response.headers.get('cache-control')).toBe('no-store')
        expect(response.headers.get('set-cookie')).toContain(`Max-Age=${expiresIn / 1000}`)
      } finally {
        await instance.close()
      }
    },
  )

  it('advertises POST for unsupported initialization methods without issuing a cookie', async () => {
    const instance = await createApp(
      createDefinition({
        app: defineApp({}),
        services: { visitors: createVisitorsAssembly(defineVisitors({ secret: SECRET })) },
      }),
    )
    try {
      for (const method of ['GET', 'HEAD', 'OPTIONS']) {
        const response = await instance.fetch(
          new Request('http://localhost/__sark/visitor', { method }),
        )
        expect(response.status, method).toBe(405)
        expect(response.headers.get('allow'), method).toBe('POST')
        expect(response.headers.get('set-cookie'), method).toBeNull()
      }
    } finally {
      await instance.close()
    }
  })

  it('rejects a conflicting initialization route while creating the application', async () => {
    await expect(
      createApp(
        createDefinition({
          app: defineApp({}),
          services: {
            visitors: createVisitorsAssembly(defineVisitors({ secret: SECRET, path: '/api/init' })),
          },
          routes: [
            {
              routePath: parseApiFilePath('init.post.ts', '/api')!,
              declaration: route().handler(() => ({ collision: true })),
            },
          ],
        }),
      ),
    ).rejects.toThrow('Route conflict')
  })

  it.each([false, true])(
    'checks CSRF independently of CORS (origin allowed=%s)',
    async (allowed) => {
      const origin = 'https://reader.example'
      const instance = await createApp(
        createDefinition({
          app: defineApp({
            cors: { origin, credentials: true },
            csrf: { origins: allowed ? [origin] : [] },
          }),
          services: { visitors: createVisitorsAssembly(defineVisitors({ secret: SECRET })) },
        }),
      )
      try {
        const preflight = await instance.fetch(
          new Request('http://localhost/__sark/visitor', {
            method: 'OPTIONS',
            headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' },
          }),
        )
        expect(preflight.status).toBe(204)
        expect(preflight.headers.get('access-control-allow-origin')).toBe(origin)
        expect(preflight.headers.get('access-control-allow-credentials')).toBe('true')

        const response = await instance.fetch(
          new Request('http://localhost/__sark/visitor', {
            method: 'POST',
            headers: { Origin: origin },
          }),
        )
        expect(response.status).toBe(allowed ? 204 : 403)
        expect(response.headers.get('access-control-allow-origin')).toBe(origin)
        if (allowed) {
          expect(response.headers.get('set-cookie')).toContain('visitor_id=')
        } else {
          expect((await response.json()).error.code).toBe('csrf_forbidden')
          expect(response.headers.get('set-cookie')).toBeNull()
        }
      } finally {
        await instance.close()
      }
    },
  )

  it('runs independently without database, auth, or stats capabilities', async () => {
    const instance = await createApp(
      createDefinition({
        app: defineApp({}),
        services: {
          visitors: createVisitorsAssembly(defineVisitors({ secret: SECRET })),
        },
        routes: [
          {
            routePath: parseApiFilePath('ping.get.ts', '/api')!,
            declaration: route().handler((ctx) => {
              return { hasVisitor: getVisitor(ctx) !== undefined, id: getVisitor(ctx).id }
            }),
          },
        ],
      }),
    )

    try {
      const response = await instance.fetch(new Request('http://localhost/api/ping'))
      expect(response.status).toBe(200)
      const data = await response.json()
      expect(data).toEqual({ hasVisitor: true, id: null })
      expect(response.headers.get('set-cookie')).toBeNull()
    } finally {
      await instance.close()
    }
  })

  it('reads valid signed cookie and performs server-side expiration check', async () => {
    const validUuid = crypto.randomUUID()
    const futureExp = Date.now() + 100_000
    const validPayload = `v1:${validUuid}:${futureExp}`
    const validSignedCookie = await generateSignedCookie('visitor_id', validPayload, SECRET)

    const expiredUuid = crypto.randomUUID()
    const pastExp = Date.now() - 100_000
    const expiredPayload = `v1:${expiredUuid}:${pastExp}`
    const expiredSignedCookie = await generateSignedCookie('visitor_id', expiredPayload, SECRET)

    const tamperedSignedCookie = validSignedCookie.replace(validUuid.slice(0, 4), 'ffff')

    const instance = await createApp(
      createDefinition({
        app: defineApp({}),
        services: {
          visitors: createVisitorsAssembly(defineVisitors({ secret: SECRET })),
        },
        routes: [
          {
            routePath: parseApiFilePath('check.get.ts', '/api')!,
            declaration: route().handler((ctx) => {
              return { id: getVisitor(ctx).id }
            }),
          },
        ],
      }),
    )

    try {
      // 1. Valid cookie -> parses correctly, does not write Set-Cookie
      const res1 = await instance.fetch(
        new Request('http://localhost/api/check', {
          headers: { Cookie: validSignedCookie },
        }),
      )
      expect(res1.status).toBe(200)
      expect((await res1.json()).id).toBe(validUuid)
      expect(res1.headers.get('set-cookie')).toBeNull()

      // 2. Expired cookie -> server-side expiration rejects, returns null
      const res2 = await instance.fetch(
        new Request('http://localhost/api/check', {
          headers: { Cookie: expiredSignedCookie },
        }),
      )
      expect(res2.status).toBe(200)
      expect((await res2.json()).id).toBeNull()
      expect(res2.headers.get('set-cookie')).toBeNull()

      // 3. Tampered cookie -> HMAC signature mismatch, returns null
      const res3 = await instance.fetch(
        new Request('http://localhost/api/check', {
          headers: { Cookie: tamperedSignedCookie },
        }),
      )
      expect(res3.status).toBe(200)
      expect((await res3.json()).id).toBeNull()
      expect(res3.headers.get('set-cookie')).toBeNull()
    } finally {
      await instance.close()
    }
  })

  it('coalesces concurrent ensure calls in the same request and inherits across internal calls', async () => {
    let capturedIdInInternal: string | null = null
    let instance: AppInstance

    instance = await createApp(
      createDefinition({
        app: defineApp({}),
        services: {
          visitors: createVisitorsAssembly(defineVisitors({ secret: SECRET })),
        },
        routes: [
          {
            routePath: parseApiFilePath('internal-target.get.ts', '/api')!,
            declaration: route().handler((ctx) => {
              capturedIdInInternal = getVisitor(ctx).id
              return { internalId: getVisitor(ctx).id }
            }),
          },
          {
            routePath: parseApiFilePath('concurrent-ensure.post.ts', '/api')!,
            declaration: route().handler(async (ctx) => {
              // Concurrently call ensure 5 times
              const results = await Promise.all([
                getVisitor(ctx).ensure(),
                getVisitor(ctx).ensure(),
                getVisitor(ctx).ensure(),
                getVisitor(ctx).ensure(),
                getVisitor(ctx).ensure(),
              ])

              // Make an internal call within the same request scope
              const internalRes = await instance.fetchInternal(
                new Request('http://localhost/api/internal-target'),
              )
              const internalData = await internalRes.json()

              return {
                results,
                liveId: getVisitor(ctx).id,
                internalData,
              }
            }),
          },
        ],
      }),
    )

    try {
      const response = await instance.fetch(
        new Request('http://localhost/api/concurrent-ensure', {
          method: 'POST',
          headers: { Origin: 'http://localhost' },
        }),
      )
      expect(response.status).toBe(200)
      const data = await response.json()

      // All concurrent ensure calls returned the exact same UUID
      const firstId = data.results[0]
      expect(firstId).toBeTruthy()
      for (const id of data.results) {
        expect(id).toBe(firstId)
      }
      expect(data.liveId).toBe(firstId)

      // Internal call inherited the exact same visitor state
      expect(capturedIdInInternal).toBe(firstId)
      expect(data.internalData.internalId).toBe(firstId)

      // Single Set-Cookie header written
      const setCookies = response.headers.getSetCookie()
      expect(setCookies.length).toBe(1)
      expect(setCookies[0]).toContain(`visitor_id=v1%3A${firstId}`)
      expect(setCookies[0]).toContain('Path=/')
      expect(setCookies[0]).toContain('HttpOnly')
      expect(setCookies[0]).toContain('SameSite=Lax')
    } finally {
      await instance.close()
    }
  })

  it('supports clear followed by ensure, writing cookies in sequence and resetting shared state', async () => {
    const existingUuid = crypto.randomUUID()
    const exp = Date.now() + 100_000
    const signedCookie = await generateSignedCookie(
      'visitor_id',
      `v1:${existingUuid}:${exp}`,
      SECRET,
    )

    const instance = await createApp(
      createDefinition({
        app: defineApp({}),
        services: {
          visitors: createVisitorsAssembly(defineVisitors({ secret: SECRET })),
        },
        routes: [
          {
            routePath: parseApiFilePath('cycle.post.ts', '/api')!,
            declaration: route().handler(async (ctx) => {
              const initial = getVisitor(ctx).id
              await getVisitor(ctx).clear()
              const afterClear = getVisitor(ctx).id
              const newId = await getVisitor(ctx).ensure()
              const afterEnsure = getVisitor(ctx).id

              return { initial, afterClear, newId, afterEnsure }
            }),
          },
        ],
      }),
    )

    try {
      const response = await instance.fetch(
        new Request('http://localhost/api/cycle', {
          method: 'POST',
          headers: { Cookie: signedCookie, Origin: 'http://localhost' },
        }),
      )
      expect(response.status).toBe(200)
      const data = await response.json()

      expect(data.initial).toBe(existingUuid)
      expect(data.afterClear).toBeNull()
      expect(data.newId).toBeTruthy()
      expect(data.newId).not.toBe(existingUuid)
      expect(data.afterEnsure).toBe(data.newId)

      // Both clear and new issuance are appended in order
      const setCookies = response.headers.getSetCookie()
      expect(setCookies.length).toBe(2)
      // 1. Cleared (Max-Age=0)
      expect(setCookies[0]).toContain('visitor_id=')
      expect(setCookies[0]).toContain('Max-Age=0')
      // 2. New signed cookie
      expect(setCookies[1]).toContain(`visitor_id=v1%3A${data.newId}`)
    } finally {
      await instance.close()
    }
  })

  it('strictly throws response_committed when mutating headers after commit, but allows reusing valid ID', async () => {
    const validUuid = crypto.randomUUID()
    const exp = Date.now() + 100_000
    const signedCookie = await generateSignedCookie('visitor_id', `v1:${validUuid}:${exp}`, SECRET)

    let caughtEnsureError: unknown
    let caughtClearError: unknown
    let reusedIdAfterCommit: string | null = null

    const instance = await createApp(
      createDefinition({
        app: defineApp({}),
        services: {
          visitors: createVisitorsAssembly(defineVisitors({ secret: SECRET })),
        },
        routes: [
          {
            routePath: parseApiFilePath('commit-test.post.ts', '/api')!,
            declaration: route().handler(async (ctx) => {
              const scope = getCurrentScope()!
              // Simulate early commit of response headers (like streaming SSR)
              await scope.commitResponseHeaders?.()

              // 1. ensure() when no ID exists must throw response_committed
              try {
                await getVisitor(ctx).ensure()
              } catch (err) {
                caughtEnsureError = err
              }

              // 2. clear() must throw response_committed
              try {
                await getVisitor(ctx).clear()
              } catch (err) {
                caughtClearError = err
              }

              return { ok: true }
            }),
          },
          {
            routePath: parseApiFilePath('reuse-after-commit.post.ts', '/api')!,
            declaration: route().handler(async (ctx) => {
              const scope = getCurrentScope()!
              await scope.commitResponseHeaders?.()

              // With an already valid ID, ensure() does not write headers and succeeds
              reusedIdAfterCommit = await getVisitor(ctx).ensure()
              return { id: reusedIdAfterCommit }
            }),
          },
        ],
      }),
    )

    try {
      // 1. Without initial cookie: ensure and clear after commit both throw
      const res1 = await instance.fetch(
        new Request('http://localhost/api/commit-test', {
          method: 'POST',
          headers: { Origin: 'http://localhost' },
        }),
      )
      expect(res1.status).toBe(200)
      expect(caughtEnsureError).toBeInstanceOf(VisitorError)
      expect((caughtEnsureError as VisitorError).code).toBe('response_committed')
      expect(caughtClearError).toBeInstanceOf(VisitorError)
      expect((caughtClearError as VisitorError).code).toBe('response_committed')

      // 2. With initial valid cookie: ensure after commit reuses without writing headers
      const res2 = await instance.fetch(
        new Request('http://localhost/api/reuse-after-commit', {
          method: 'POST',
          headers: { Cookie: signedCookie, Origin: 'http://localhost' },
        }),
      )
      expect(res2.status).toBe(200)
      expect(reusedIdAfterCommit).toBe(validUuid)
    } finally {
      await instance.close()
    }
  })

  it('keeps visitor ID decoupled from authentication (login & logout preserve visitor identity)', async () => {
    const visitorUuid = crypto.randomUUID()
    const exp = Date.now() + 100_000
    const visitorCookie = await generateSignedCookie(
      'visitor_id',
      `v1:${visitorUuid}:${exp}`,
      SECRET,
    )

    let capturedVisitorAtLogin: string | null = null
    let capturedVisitorAtLogout: string | null = null

    const instance = await createApp(
      createDefinition({
        app: defineApp({}),
        services: {
          visitors: createVisitorsAssembly(defineVisitors({ secret: SECRET })),
          auth: createAuthAssembly(defineAuth({ secret: AUTH_SECRET })),
        },
        routes: [
          {
            routePath: parseApiFilePath('login.post.ts', '/api')!,
            declaration: route().handler(async (ctx) => {
              capturedVisitorAtLogin = getVisitor(ctx).id
              await getAuth(ctx).signIn({ sub: 'user-42' })
              return { visitorId: getVisitor(ctx).id }
            }),
          },
          {
            routePath: parseApiFilePath('logout.post.ts', '/api')!,
            declaration: route().handler(async (ctx) => {
              capturedVisitorAtLogout = getVisitor(ctx).id
              await getAuth(ctx).signOut()
              return { visitorId: getVisitor(ctx).id }
            }),
          },
        ],
      }),
    )

    try {
      // 1. Sign in preserves visitor
      const loginRes = await instance.fetch(
        new Request('http://localhost/api/login', {
          method: 'POST',
          headers: { Cookie: visitorCookie, Origin: 'http://localhost' },
        }),
      )
      expect(loginRes.status).toBe(200)
      expect(capturedVisitorAtLogin).toBe(visitorUuid)
      expect((await loginRes.json()).visitorId).toBe(visitorUuid)

      // 2. Sign out preserves visitor
      const logoutRes = await instance.fetch(
        new Request('http://localhost/api/logout', {
          method: 'POST',
          headers: { Cookie: visitorCookie, Origin: 'http://localhost' },
        }),
      )
      expect(logoutRes.status).toBe(200)
      expect(capturedVisitorAtLogout).toBe(visitorUuid)
      expect((await logoutRes.json()).visitorId).toBe(visitorUuid)
    } finally {
      await instance.close()
    }
  })

  it('enforces Cache-Control: no-store when visitor cookie is mutated (ensure or clear) even if handler specifies public cache', async () => {
    const instance = await createApp(
      createDefinition({
        app: defineApp({}),
        services: {
          visitors: createVisitorsAssembly(defineVisitors({ secret: SECRET })),
        },
        routes: [
          {
            routePath: parseApiFilePath('mutated-with-public-cache.get.ts', '/api')!,
            declaration: route().handler(async (ctx) => {
              // Explicitly set public cache before ensuring visitor
              ctx.header('Cache-Control', 'public, max-age=300')
              await getVisitor(ctx).ensure()
              return { ok: true }
            }),
          },
          {
            routePath: parseApiFilePath('clear-with-public-cache.get.ts', '/api')!,
            declaration: route().handler(async (ctx) => {
              ctx.header('Cache-Control', 'public, max-age=300')
              await getVisitor(ctx).clear()
              return { ok: true }
            }),
          },
        ],
      }),
    )

    try {
      // 1. ensure() mutates cookie -> Cache-Control is overridden to no-store
      const res1 = await instance.fetch(
        new Request('http://localhost/api/mutated-with-public-cache'),
      )
      expect(res1.status).toBe(200)
      expect(res1.headers.get('set-cookie')).toBeTruthy()
      expect(res1.headers.get('cache-control')).toBe('no-store')

      // 2. clear() mutates cookie -> Cache-Control is overridden to no-store
      const res2 = await instance.fetch(new Request('http://localhost/api/clear-with-public-cache'))
      expect(res2.status).toBe(200)
      expect(res2.headers.get('set-cookie')).toBeTruthy()
      expect(res2.headers.get('cache-control')).toBe('no-store')
    } finally {
      await instance.close()
    }
  })

  it('throws VisitorError with code response_committed if headers are committed while waiting for cookie signing', async () => {
    let caughtError: unknown

    const instance = await createApp(
      createDefinition({
        app: defineApp({}),
        services: {
          visitors: createVisitorsAssembly(defineVisitors({ secret: SECRET })),
        },
        routes: [
          {
            routePath: parseApiFilePath('race-commit.post.ts', '/api')!,
            declaration: route().handler(async (ctx) => {
              const scope = getCurrentScope()!

              // Trigger ensure() and concurrently commit headers
              const ensurePromise = getVisitor(ctx).ensure()
              await scope.commitResponseHeaders?.()

              try {
                await ensurePromise
              } catch (err) {
                caughtError = err
              }

              return { ok: true }
            }),
          },
        ],
      }),
    )

    try {
      const res = await instance.fetch(
        new Request('http://localhost/api/race-commit', {
          method: 'POST',
          headers: { Origin: 'http://localhost' },
        }),
      )
      expect(res.status).toBe(200)
      expect(caughtError).toBeInstanceOf(VisitorError)
      expect((caughtError as VisitorError).code).toBe('response_committed')
    } finally {
      await instance.close()
    }
  })

  it('applies custom cookie name, path, domain, and sameSite on clear and ensure while keeping live state synchronized across internal calls', async () => {
    const CUSTOM_COOKIE_NAME = 'custom_visitor_token'
    const CUSTOM_PATH = '/app'
    const CUSTOM_DOMAIN = 'sub.example.test'
    const initialUuid = crypto.randomUUID()
    const exp = Date.now() + 100_000
    const initialCookie = await generateSignedCookie(
      CUSTOM_COOKIE_NAME,
      `v1:${initialUuid}:${exp}`,
      SECRET,
    )

    let capturedIdInInternalAfterClear: string | null = 'not-called'
    let capturedIdInInternalAfterEnsure: string | null = 'not-called'

    const instance = await createApp(
      createDefinition({
        app: defineApp({ hosts: 'sub.example.test' }),
        services: {
          visitors: createVisitorsAssembly(
            defineVisitors({
              secret: SECRET,
              cookieName: CUSTOM_COOKIE_NAME,
              cookie: {
                path: CUSTOM_PATH,
                domain: CUSTOM_DOMAIN,
                sameSite: 'strict',
              },
            }),
          ),
        },
        routes: [
          {
            routePath: parseApiFilePath('cycle-with-internal.post.ts', '/app')!,
            declaration: route().handler(async (ctx) => {
              const initialId = getVisitor(ctx).id

              // 1. Clear visitor cookie
              await getVisitor(ctx).clear()
              const outerIdAfterClear = getVisitor(ctx).id

              // Internal call after clear
              await instance.fetchInternal(
                new Request('http://sub.example.test/app/check-after-clear'),
              )

              // 2. Ensure new visitor ID
              const ensuredNewId = await getVisitor(ctx).ensure()
              const outerIdAfterEnsure = getVisitor(ctx).id

              // Internal call after ensure
              await instance.fetchInternal(
                new Request('http://sub.example.test/app/check-after-ensure'),
              )

              return {
                initialId,
                outerIdAfterClear,
                ensuredNewId,
                outerIdAfterEnsure,
              }
            }),
          },
          {
            routePath: parseApiFilePath('check-after-clear.get.ts', '/app')!,
            declaration: route().handler((ctx) => {
              capturedIdInInternalAfterClear = getVisitor(ctx).id
              return { id: getVisitor(ctx).id }
            }),
          },
          {
            routePath: parseApiFilePath('check-after-ensure.get.ts', '/app')!,
            declaration: route().handler((ctx) => {
              capturedIdInInternalAfterEnsure = getVisitor(ctx).id
              return { id: getVisitor(ctx).id }
            }),
          },
        ],
      }),
    )

    try {
      const response = await instance.fetch(
        new Request('http://sub.example.test/app/cycle-with-internal', {
          method: 'POST',
          headers: { Cookie: initialCookie, Origin: 'http://sub.example.test' },
        }),
      )
      expect(response.status).toBe(200)
      const data = await response.json()

      // Initial ID read correctly
      expect(data.initialId).toBe(initialUuid)

      // State after clear is null both in outer handler and in internal subrequest
      expect(data.outerIdAfterClear).toBeNull()
      expect(capturedIdInInternalAfterClear).toBeNull()

      // State after ensure is updated to newly generated ID
      expect(data.ensuredNewId).toBeTruthy()
      expect(data.ensuredNewId).not.toBe(initialUuid)
      expect(data.outerIdAfterEnsure).toBe(data.ensuredNewId)
      expect(capturedIdInInternalAfterEnsure).toBe(data.ensuredNewId)

      // Set-Cookie headers verify custom name, path, domain, sameSite
      const setCookies = response.headers.getSetCookie()
      expect(setCookies.length).toBe(2)

      // 1. Clear header
      expect(setCookies[0]).toContain(`${CUSTOM_COOKIE_NAME}=;`)
      expect(setCookies[0]).toContain(`Path=${CUSTOM_PATH}`)
      expect(setCookies[0]).toContain(`Domain=${CUSTOM_DOMAIN}`)
      expect(setCookies[0]).toContain('Max-Age=0')
      expect(setCookies[0]).toContain('SameSite=Strict')

      // 2. Ensure header
      expect(setCookies[1]).toContain(`${CUSTOM_COOKIE_NAME}=v1%3A${data.ensuredNewId}`)
      expect(setCookies[1]).toContain(`Path=${CUSTOM_PATH}`)
      expect(setCookies[1]).toContain(`Domain=${CUSTOM_DOMAIN}`)
      expect(setCookies[1]).toContain('SameSite=Strict')
      expect(setCookies[1]).toContain('HttpOnly')
    } finally {
      await instance.close()
    }
  })

  it('isolates secrets and visitor states across different Workers events while reusing state in internal calls within the same event', async () => {
    interface WorkerEnv {
      VISITOR_SECRET: string
    }

    let factoryCallCount = 0
    const definition = createDefinition({
      app: defineApp({}),
      services: {
        visitors: createVisitorsAssembly(
          defineVisitors<WorkerEnv>((env) => {
            factoryCallCount++
            return { secret: env.VISITOR_SECRET }
          }),
        ),
      },
      routes: [
        {
          routePath: parseApiFilePath('init.post.ts', '/api')!,
          declaration: route().handler(async (ctx) => {
            const id = await getVisitor(ctx).ensure()
            return { id }
          }),
        },
        {
          routePath: parseApiFilePath('inspect.get.ts', '/api')!,
          declaration: route().handler(async (ctx) => {
            const scope = getCurrentScope()!
            // Internal subrequest within same event
            const subRes = await scope.app!.fetchInternal(
              new Request('http://localhost/api/internal-inspect'),
            )
            const subData = await subRes.json()
            return {
              outerId: getVisitor(ctx).id,
              internalId: subData.id,
            }
          }),
        },
        {
          routePath: parseApiFilePath('internal-inspect.get.ts', '/api')!,
          declaration: route().handler((ctx) => {
            return { id: getVisitor(ctx).id }
          }),
        },
      ],
    })

    const handler = createWorkerHandler(definition)
    const ctxA = { waitUntil: () => {}, passThroughOnException: () => {} }
    const ctxB = { waitUntil: () => {}, passThroughOnException: () => {} }

    const envA: WorkerEnv = { VISITOR_SECRET: 'secret-for-tenant-a-at-least-32-chars!' }
    const envB: WorkerEnv = { VISITOR_SECRET: 'secret-for-tenant-b-at-least-32-chars!' }

    // 1. Initialize visitor under Event A (Tenant A)
    const initResA = await handler.fetch(
      new Request('http://localhost/api/init', {
        method: 'POST',
        headers: { Origin: 'http://localhost' },
      }),
      envA,
      ctxA,
    )
    expect(initResA.status).toBe(200)
    const idA = (await initResA.json()).id
    expect(idA).toBeTruthy()
    const cookieHeaderA = initResA.headers.get('set-cookie')
    expect(cookieHeaderA).toBeTruthy()
    const cookieValA = cookieHeaderA!.split(';')[0]

    // 2. Initialize visitor under Event B (Tenant B)
    const initResB = await handler.fetch(
      new Request('http://localhost/api/init', {
        method: 'POST',
        headers: { Origin: 'http://localhost' },
      }),
      envB,
      ctxB,
    )
    expect(initResB.status).toBe(200)
    const idB = (await initResB.json()).id
    expect(idB).toBeTruthy()
    expect(idB).not.toBe(idA)
    const cookieHeaderB = initResB.headers.get('set-cookie')
    expect(cookieHeaderB).toBeTruthy()
    const cookieValB = cookieHeaderB!.split(';')[0]

    // 3. Request with Tenant A's cookie to Tenant A:
    // Outer and internal call reuse the exact same visitor ID
    const resA = await handler.fetch(
      new Request('http://localhost/api/inspect', {
        headers: { Cookie: cookieValA },
      }),
      envA,
      ctxA,
    )
    expect(resA.status).toBe(200)
    const dataA = await resA.json()
    expect(dataA.outerId).toBe(idA)
    expect(dataA.internalId).toBe(idA)

    // 4. Request with Tenant A's cookie to Tenant B:
    // Secret mismatch results in signature rejection (id is null), isolating tenant secrets
    const crossResB = await handler.fetch(
      new Request('http://localhost/api/inspect', {
        headers: { Cookie: cookieValA },
      }),
      envB,
      ctxB,
    )
    expect(crossResB.status).toBe(200)
    const crossDataB = await crossResB.json()
    expect(crossDataB.outerId).toBeNull()
    expect(crossDataB.internalId).toBeNull()

    // 5. Request with Tenant B's cookie to Tenant A:
    // Secret mismatch results in signature rejection
    const crossResA = await handler.fetch(
      new Request('http://localhost/api/inspect', {
        headers: { Cookie: cookieValB },
      }),
      envA,
      ctxA,
    )
    expect(crossResA.status).toBe(200)
    const crossDataA = await crossResA.json()
    expect(crossDataA.outerId).toBeNull()
    expect(crossDataA.internalId).toBeNull()

    // 5 distinct top-level events evaluated factory once each; internal subrequests reuse event config
    expect(factoryCallCount).toBe(5)
  })
})
