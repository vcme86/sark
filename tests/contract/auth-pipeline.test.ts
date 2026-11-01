import { Context } from 'hono'
import { parse } from 'hono/utils/cookie'
import { describe, expect, it, vi } from 'vitest'

import { getCurrentScope } from '../../src/core/context'
import { createApp } from '../../src/core/create'
import { createDefinition } from '../../src/core/definition'
import { type AuthDeclaration, defineAuth, signToken } from '../../src/entries/auth/session'
import { type AppDeclaration, defineApp } from '../../src/entries/server'
import type { RouteEntry } from '../../src/http/server/types'
import { requireStepUp } from '../../src/services/auth/guard'
import { createAuthAssembly } from '../../src/services/auth/session/assembly'

/**
 * Full-stack contract tests for first-party authentication pipeline,
 * Bearer/Cookie resolution, CSRF interaction, and rolling renewal.
 */

const TEST_SECRET = 'a-very-long-secret-key-that-is-at-least-32-bytes-long!'

function createAuthTestDefinition(input: {
  app?: AppDeclaration
  auth: AuthDeclaration
  routes?: any[]
  createPageConfigResolver?: () => (env: unknown) => unknown
  apiPrefix?: string
}) {
  return createDefinition({
    app: input.app,
    services: {
      auth: createAuthAssembly(input.auth),
    },
    routes: input.routes,
    createPageConfigResolver: input.createPageConfigResolver,
    apiPrefix: input.apiPrefix,
  })
}

describe('Auth Pipeline & Request Context Integration', () => {
  it('authenticates via Bearer token and bypasses CSRF on mutating requests', async () => {
    const appDecl = defineApp({
      hosts: 'localhost',
      csrf: true,
    })

    const authDecl = defineAuth({
      secret: TEST_SECRET,
    })

    const testRoute: RouteEntry = {
      routePath: {
        urlPath: '/api/profile',
        clientPath: '/api/profile',
        shapeKey: '/api/profile',
        method: 'POST',
        segments: [
          { kind: 'static', raw: 'api' },
          { kind: 'static', raw: 'profile' },
        ],
        isSse: false,
        isWs: false,
      },
      kind: 'api',
      declaration: {
        options: { csrf: true, middleware: [] },
        validators: {},
        isRoute: true,
        handler: async (ctx: Context) => {
          const auth = (ctx.var as any).auth
          return ctx.json({
            authenticated: Boolean(auth?.identity),
            sub: auth?.identity?.sub,
          })
        },
      } as any,
    }

    const definition = createAuthTestDefinition({
      app: appDecl,
      auth: authDecl,
      routes: [testRoute],
    })

    const instance = await createApp(definition)

    // 1. Mutating POST without auth and without Origin/Referer -> CSRF rejected (403)
    const unauthedRes = await instance.fetch(
      new Request('http://localhost/api/profile', {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    )
    expect(unauthedRes.status).toBe(403)

    // Sign a valid token
    const token = await signToken({ sub: 'user-42', roles: ['admin'] }, { secret: TEST_SECRET })

    // 2. A validated Bearer credential exempts the request from Cookie-based CSRF checks.
    const bearerRes = await instance.fetch(
      new Request('http://localhost/api/profile', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      }),
    )
    expect(bearerRes.status).toBe(200)
    const data = (await bearerRes.json()) as any
    expect(data.authenticated).toBe(true)
    expect(data.sub).toBe('user-42')

    // 3. An invalid Bearer credential does not grant a CSRF exemption.
    const invalidBearerRes = await instance.fetch(
      new Request('http://localhost/api/profile', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer invalid.token.payload',
        },
        body: 'action=update',
      }),
    )
    expect(invalidBearerRes.status).toBe(403)

    await instance.close()
  })

  it('supports signIn and signOut with cookies', async () => {
    const appDecl = defineApp({
      hosts: 'localhost',
    })

    const authDecl = defineAuth({
      secret: TEST_SECRET,
      cookieName: 'custom_session',
    })

    const loginRoute: RouteEntry = {
      routePath: {
        urlPath: '/api/login',
        clientPath: '/api/login',
        shapeKey: '/api/login',
        method: 'POST',
        segments: [
          { kind: 'static', raw: 'api' },
          { kind: 'static', raw: 'login' },
        ],
        isSse: false,
        isWs: false,
      },
      kind: 'api',
      declaration: {
        options: { csrf: false, middleware: [] },
        validators: {},
        isRoute: true,
        handler: async (ctx: Context) => {
          const auth = (ctx.var as any).auth
          const session = await auth.signIn({ sub: 'alice', claims: { plan: 'pro' } })
          return ctx.json({ ok: true, token: session.token })
        },
      } as any,
    }

    const logoutRoute: RouteEntry = {
      routePath: {
        urlPath: '/api/logout',
        clientPath: '/api/logout',
        shapeKey: '/api/logout',
        method: 'POST',
        segments: [
          { kind: 'static', raw: 'api' },
          { kind: 'static', raw: 'logout' },
        ],
        isSse: false,
        isWs: false,
      },
      kind: 'api',
      declaration: {
        options: { csrf: false, middleware: [] },
        validators: {},
        isRoute: true,
        handler: async (ctx: Context) => {
          const auth = (ctx.var as any).auth
          await auth.signOut()
          return ctx.json({ ok: true })
        },
      } as any,
    }

    const meRoute: RouteEntry = {
      routePath: {
        urlPath: '/api/me',
        clientPath: '/api/me',
        shapeKey: '/api/me',
        method: 'GET',
        segments: [
          { kind: 'static', raw: 'api' },
          { kind: 'static', raw: 'me' },
        ],
        isSse: false,
        isWs: false,
      },
      kind: 'api',
      declaration: {
        options: { csrf: false, middleware: [] },
        validators: {},
        isRoute: true,
        handler: async (ctx: Context) => {
          const auth = (ctx.var as any).auth
          return ctx.json({ identity: auth?.identity })
        },
      } as any,
    }

    const definition = createAuthTestDefinition({
      app: appDecl,
      auth: authDecl,
      routes: [loginRoute, logoutRoute, meRoute],
    })

    const instance = await createApp(definition)

    // 1. Call login -> receives Set-Cookie
    const loginRes = await instance.fetch(
      new Request('http://localhost/api/login', { method: 'POST' }),
    )
    expect(loginRes.status).toBe(200)
    const setCookie = loginRes.headers.get('set-cookie')
    expect(setCookie).toBeTruthy()
    expect(setCookie).toContain('custom_session=')
    expect(setCookie).toContain('HttpOnly')

    const parsedCookies = parse(setCookie!, 'custom_session')
    const sessionToken = parsedCookies['custom_session']
    expect(sessionToken).toBeTruthy()

    // 2. Call /api/me with session cookie -> authenticated
    const meRes = await instance.fetch(
      new Request('http://localhost/api/me', {
        headers: {
          Cookie: `custom_session=${sessionToken}`,
        },
      }),
    )
    expect(meRes.status).toBe(200)
    const meData = (await meRes.json()) as any
    expect(meData.identity).toBeTruthy()
    expect(meData.identity.sub).toBe('alice')
    expect(meData.identity.claims.plan).toBe('pro')

    // 3. Call /api/logout -> receives clearance Set-Cookie with Max-Age=0
    const logoutRes = await instance.fetch(
      new Request('http://localhost/api/logout', {
        method: 'POST',
        headers: {
          Cookie: `custom_session=${sessionToken}`,
        },
      }),
    )
    expect(logoutRes.status).toBe(200)
    const logoutCookie = logoutRes.headers.get('set-cookie')
    expect(logoutCookie).toContain('Max-Age=0')

    await instance.close()
  })

  it('supports signIn with cookie=false for Bearer token delivery without Set-Cookie', async () => {
    const appDecl = defineApp({
      hosts: 'localhost',
    })

    const authDecl = defineAuth({
      secret: TEST_SECRET,
    })

    const loginBearerRoute: RouteEntry = {
      routePath: {
        urlPath: '/api/login-bearer',
        clientPath: '/api/login-bearer',
        shapeKey: '/api/login-bearer',
        method: 'POST',
        segments: [
          { kind: 'static', raw: 'api' },
          { kind: 'static', raw: 'login-bearer' },
        ],
        isSse: false,
        isWs: false,
      },
      kind: 'api',
      declaration: {
        options: { csrf: false, middleware: [] },
        validators: {},
        isRoute: true,
        handler: async (ctx: Context) => {
          const auth = (ctx.var as any).auth
          const issued = await auth.signIn({ sub: 'bearer-user' }, { cookie: false })
          return ctx.json({ token: issued.token, sub: issued.identity.sub })
        },
      } as any,
    }

    const meRoute: RouteEntry = {
      routePath: {
        urlPath: '/api/me',
        clientPath: '/api/me',
        shapeKey: '/api/me',
        method: 'GET',
        segments: [
          { kind: 'static', raw: 'api' },
          { kind: 'static', raw: 'me' },
        ],
        isSse: false,
        isWs: false,
      },
      kind: 'api',
      declaration: {
        options: { csrf: false, middleware: [] },
        validators: {},
        isRoute: true,
        handler: async (ctx: Context) => {
          const auth = (ctx.var as any).auth
          return ctx.json({ sub: auth?.identity?.sub })
        },
      } as any,
    }

    const definition = createAuthTestDefinition({
      app: appDecl,
      auth: authDecl,
      routes: [loginBearerRoute, meRoute],
    })

    const instance = await createApp(definition)

    const loginRes = await instance.fetch(
      new Request('http://localhost/api/login-bearer', {
        method: 'POST',
      }),
    )
    expect(loginRes.status).toBe(200)
    // CRITICAL: MUST NOT set Set-Cookie when cookie: false
    expect(loginRes.headers.get('set-cookie')).toBeNull()

    const body = (await loginRes.json()) as any
    expect(body.sub).toBe('bearer-user')
    expect(body.token).toBeTruthy()

    // Subsequent request authenticates via Bearer
    const meRes = await instance.fetch(
      new Request('http://localhost/api/me', {
        headers: {
          Authorization: `Bearer ${body.token}`,
        },
      }),
    )
    expect(meRes.status).toBe(200)
    expect((await meRes.json()).sub).toBe('bearer-user')

    await instance.close()
  })

  it('automatically rolls cookie session when remaining lifetime < expiresIn / 2', async () => {
    const appDecl = defineApp({
      hosts: 'localhost',
    })

    const authDecl = defineAuth({
      secret: TEST_SECRET,
      expiresIn: 4000, // 4 seconds
      rolling: true,
    })

    const meRoute: RouteEntry = {
      routePath: {
        urlPath: '/api/me',
        clientPath: '/api/me',
        shapeKey: '/api/me',
        method: 'GET',
        segments: [
          { kind: 'static', raw: 'api' },
          { kind: 'static', raw: 'me' },
        ],
        isSse: false,
        isWs: false,
      },
      kind: 'api',
      declaration: {
        options: { csrf: false, middleware: [] },
        validators: {},
        isRoute: true,
        handler: async (ctx: Context) => {
          const auth = (ctx.var as any).auth
          return ctx.json({ sub: auth?.identity?.sub })
        },
      } as any,
    }

    const definition = createAuthTestDefinition({
      app: appDecl,
      auth: authDecl,
      routes: [meRoute],
    })

    const instance = await createApp(definition)

    try {
      vi.useFakeTimers()
      // Sign a fresh token with configured 4s expiry
      const token = await signToken({ sub: 'bob' }, { secret: TEST_SECRET, expiresIn: 4000 })

      // Advance 2.2s so remaining lifetime (~1800ms) is less than half of configured expiresIn (2000ms)
      vi.advanceTimersByTime(2200)

      const res = await instance.fetch(
        new Request('http://localhost/api/me', {
          headers: {
            Cookie: `auth_token=${token}`,
          },
        }),
      )
      expect(res.status).toBe(200)

      // Should have re-issued Set-Cookie
      const setCookie = res.headers.get('set-cookie')
      expect(setCookie).toBeTruthy()
      expect(setCookie).toContain('auth_token=')

      const renewedToken = parse(setCookie!, 'auth_token').auth_token
      const { decode } = await import('hono/jwt')
      const originalPayload = decode(token).payload
      const renewedPayload = decode(renewedToken).payload
      expect(renewedPayload.sub).toBe('bob')
      expect(renewedPayload.jti).toBe(originalPayload.jti)
      expect(renewedPayload.iat).toBe(originalPayload.iat)
      expect(renewedPayload.exp!).toBeGreaterThan(originalPayload.exp!)
    } finally {
      vi.useRealTimers()
      await instance.close()
    }
  })

  it('shares Cookie identity with internal API dispatch', async () => {
    const appDecl = defineApp({
      hosts: 'localhost',
    })

    const authDecl = defineAuth({
      secret: TEST_SECRET,
    })

    const internalDataRoute: RouteEntry = {
      routePath: {
        urlPath: '/api/data',
        clientPath: '/api/data',
        shapeKey: '/api/data',
        method: 'GET',
        segments: [
          { kind: 'static', raw: 'api' },
          { kind: 'static', raw: 'data' },
        ],
        isSse: false,
        isWs: false,
      },
      kind: 'api',
      declaration: {
        options: { csrf: false, middleware: [] },
        validators: {},
        isRoute: true,
        handler: async (ctx: Context) => {
          const auth = (ctx.var as any).auth
          return ctx.json({ sub: auth?.identity?.sub })
        },
      } as any,
    }

    const ssrPageRoute: RouteEntry = {
      routePath: {
        urlPath: '/page',
        clientPath: '/page',
        shapeKey: '/page',
        method: 'GET',
        segments: [{ kind: 'static', raw: 'page' }],
        isSse: false,
        isWs: false,
      },
      kind: 'api',
      declaration: {
        options: { csrf: false, middleware: [] },
        validators: {},
        isRoute: true,
        handler: async (ctx: Context) => {
          // Internal dispatch inherits the outer request's verified identity.
          const internalRes = await getCurrentScope()!.app!.fetchInternal(
            new Request('http://localhost/api/data'),
          )
          const data = await internalRes.json()
          return ctx.json({ fromSsr: true, internalSub: data.sub })
        },
      } as any,
    }

    const definition = createAuthTestDefinition({
      app: appDecl,
      auth: authDecl,
      routes: [internalDataRoute, ssrPageRoute],
    })

    const instance = await createApp(definition)

    const token = await signToken({ sub: 'charlie' }, { secret: TEST_SECRET })

    const res = await instance.fetch(
      new Request('http://localhost/page', {
        headers: {
          Cookie: `auth_token=${token}`,
        },
      }),
    )
    expect(res.status).toBe(200)
    const json = (await res.json()) as any
    expect(json.fromSsr).toBe(true)
    expect(json.internalSub).toBe('charlie')

    await instance.close()
  })

  it('enforces step-up authentication guard', async () => {
    const appDecl = defineApp({
      hosts: 'localhost',
    })

    const authDecl = defineAuth({
      secret: TEST_SECRET,
    })

    const sensitiveRoute: RouteEntry = {
      routePath: {
        urlPath: '/api/transfer',
        clientPath: '/api/transfer',
        shapeKey: '/api/transfer',
        method: 'POST',
        segments: [
          { kind: 'static', raw: 'api' },
          { kind: 'static', raw: 'transfer' },
        ],
        isSse: false,
        isWs: false,
      },
      kind: 'api',
      declaration: {
        options: { csrf: false, middleware: [] },
        validators: {},
        isRoute: true,
        handler: async (ctx: Context) => {
          // require step up within 60 seconds (60,000 ms) and 'mfa' amr
          const guard = requireStepUp({ maxAge: 60_000, amr: 'mfa' })
          await guard(ctx, async () => {})
          return ctx.json({ transferred: true })
        },
      } as any,
    }

    const definition = createAuthTestDefinition({
      app: appDecl,
      auth: authDecl,
      routes: [sensitiveRoute],
    })

    const instance = await createApp(definition)

    // 1. Token without authTime -> 403 step_up_required
    const tokenNoAuthTime = await signToken({ sub: 'dave' }, { secret: TEST_SECRET })
    const res1 = await instance.fetch(
      new Request('http://localhost/api/transfer', {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenNoAuthTime}` },
      }),
    )
    expect(res1.status).toBe(403)

    // 2. Token with expired authTime (old login 500s ago) -> 403 step_up_required
    const tokenOldAuth = await signToken(
      {
        sub: 'dave',
        authTime: Math.floor(Date.now() / 1000) - 500,
        amr: ['mfa'],
      },
      { secret: TEST_SECRET },
    )
    const res2 = await instance.fetch(
      new Request('http://localhost/api/transfer', {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenOldAuth}` },
      }),
    )
    expect(res2.status).toBe(403)

    // 3. Token with fresh authTime but missing 'mfa' amr -> 403 step_up_required
    const tokenNoMfa = await signToken(
      {
        sub: 'dave',
        authTime: Math.floor(Date.now() / 1000) - 10,
        amr: ['pwd'],
      },
      { secret: TEST_SECRET },
    )
    const res3 = await instance.fetch(
      new Request('http://localhost/api/transfer', {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenNoMfa}` },
      }),
    )
    expect(res3.status).toBe(403)

    // 4. Token with fresh authTime AND 'mfa' amr -> 200 OK
    const tokenValid = await signToken(
      {
        sub: 'dave',
        authTime: Math.floor(Date.now() / 1000) - 10,
        amr: ['pwd', 'mfa'],
      },
      { secret: TEST_SECRET },
    )
    const res4 = await instance.fetch(
      new Request('http://localhost/api/transfer', {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenValid}` },
      }),
    )
    expect(res4.status).toBe(200)
    const json4 = (await res4.json()) as any
    expect(json4.transferred).toBe(true)

    await instance.close()
  })

  it('shares auth session state when anonymous outer request performs internal signIn', async () => {
    const appDecl = defineApp({ hosts: 'localhost' })
    const authDecl = defineAuth({ secret: TEST_SECRET })

    const internalLoginRoute: RouteEntry = {
      routePath: {
        urlPath: '/api/login',
        clientPath: '/api/login',
        shapeKey: '/api/login',
        method: 'POST',
        segments: [
          { kind: 'static', raw: 'api' },
          { kind: 'static', raw: 'login' },
        ],
        isSse: false,
        isWs: false,
      },
      kind: 'api',
      declaration: {
        options: { csrf: false, middleware: [] },
        validators: {},
        isRoute: true,
        handler: async (ctx: Context) => {
          const auth = ctx.get('auth' as any) as any
          await auth.signIn({ sub: 'alice-logged-in' })
          return ctx.json({ ok: true })
        },
      } as any,
    }

    const outerPageRoute: RouteEntry = {
      routePath: {
        urlPath: '/page/do-login',
        clientPath: '/page/do-login',
        shapeKey: '/page/do-login',
        method: 'GET',
        segments: [
          { kind: 'static', raw: 'page' },
          { kind: 'static', raw: 'do-login' },
        ],
        isSse: false,
        isWs: false,
      },
      kind: 'api',
      declaration: {
        options: { middleware: [] },
        validators: {},
        isRoute: true,
        handler: async (ctx: Context) => {
          const app = getCurrentScope()!.app as any
          // Call internal login
          const internalRes = await app.fetchInternal(
            new Request('http://localhost/api/login', { method: 'POST' }),
          )
          expect(internalRes.status).toBe(200)

          // Outer handler immediately observes updated identity
          const outerAuth = ctx.get('auth' as any) as any
          return ctx.json({
            outerObservedSub: outerAuth.identity?.sub,
          })
        },
      } as any,
    }

    const definition = createAuthTestDefinition({
      app: appDecl,
      auth: authDecl,
      routes: [internalLoginRoute, outerPageRoute],
    })

    const instance = await createApp(definition)

    const res = await instance.fetch(new Request('http://localhost/page/do-login'))
    expect(res.status).toBe(200)
    const json = (await res.json()) as any
    expect(json.outerObservedSub).toBe('alice-logged-in')

    // Response includes the Set-Cookie for the newly signed in session
    const setCookie = res.headers.get('set-cookie')
    expect(setCookie).toBeTruthy()
    expect(setCookie).toContain('auth_token=')
    expect(setCookie).not.toContain('Max-Age=0')

    await instance.close()
  })

  it('prevents auto-renewal from overwriting internal signOut on expiring token', async () => {
    const appDecl = defineApp({ hosts: 'localhost' })
    const authDecl = defineAuth({ secret: TEST_SECRET, expiresIn: 4000, rolling: true })

    const internalLogoutRoute: RouteEntry = {
      routePath: {
        urlPath: '/api/logout',
        clientPath: '/api/logout',
        shapeKey: '/api/logout',
        method: 'POST',
        segments: [
          { kind: 'static', raw: 'api' },
          { kind: 'static', raw: 'logout' },
        ],
        isSse: false,
        isWs: false,
      },
      kind: 'api',
      declaration: {
        options: { csrf: false, middleware: [] },
        validators: {},
        isRoute: true,
        handler: async (ctx: Context) => {
          const auth = ctx.get('auth' as any) as any
          await auth.signOut()
          return ctx.json({ loggedOut: true })
        },
      } as any,
    }

    const outerPageRoute: RouteEntry = {
      routePath: {
        urlPath: '/page/do-logout',
        clientPath: '/page/do-logout',
        shapeKey: '/page/do-logout',
        method: 'GET',
        segments: [
          { kind: 'static', raw: 'page' },
          { kind: 'static', raw: 'do-logout' },
        ],
        isSse: false,
        isWs: false,
      },
      kind: 'api',
      declaration: {
        options: { middleware: [] },
        validators: {},
        isRoute: true,
        handler: async (ctx: Context) => {
          const app = getCurrentScope()!.app as any
          await app.fetchInternal(new Request('http://localhost/api/logout', { method: 'POST' }))
          const outerAuth = ctx.get('auth' as any) as any
          return ctx.json({ outerIdentity: outerAuth.identity })
        },
      } as any,
    }

    const definition = createAuthTestDefinition({
      app: appDecl,
      auth: authDecl,
      routes: [internalLogoutRoute, outerPageRoute],
    })

    const instance = await createApp(definition)

    // Token has 4s expiry. Advance 2.2s so it is eligible for renewal
    try {
      vi.useFakeTimers()
      const token = await signToken(
        { sub: 'user-to-logout' },
        { secret: TEST_SECRET, expiresIn: 4000 },
      )
      vi.advanceTimersByTime(2200)

      const res = await instance.fetch(
        new Request('http://localhost/page/do-logout', {
          headers: { Cookie: `auth_token=${token}` },
        }),
      )
      expect(res.status).toBe(200)
      const json = (await res.json()) as any
      expect(json.outerIdentity).toBeNull()

      // The response MUST contain the deletion cookie and NOT an auto-renewed token!
      const setCookies = res.headers.getSetCookie()
      expect(setCookies.length).toBeGreaterThan(0)
      const lastCookie = setCookies[setCookies.length - 1]
      expect(lastCookie).toContain('Max-Age=0')
      // Ensure no renewed token was appended afterwards
      expect(setCookies.some((c) => c.includes('Max-Age=0'))).toBe(true)
      expect(setCookies.every((c) => !c.includes('Max-Age=4'))).toBe(true)
    } finally {
      vi.useRealTimers()
      await instance.close()
    }
  })

  it('calculates renewal threshold based on configured expiresIn without drift', async () => {
    // 7 days token = 604_800s. Threshold = 302_400s (3.5 days).
    const appDecl = defineApp({ hosts: 'localhost' })
    const authDecl = defineAuth({ secret: TEST_SECRET, expiresIn: 604_800_000, rolling: true })

    const meRoute: RouteEntry = {
      routePath: {
        urlPath: '/api/check',
        clientPath: '/api/check',
        shapeKey: '/api/check',
        method: 'GET',
        segments: [
          { kind: 'static', raw: 'api' },
          { kind: 'static', raw: 'check' },
        ],
        isSse: false,
        isWs: false,
      },
      kind: 'api',
      declaration: {
        options: { middleware: [] },
        validators: {},
        isRoute: true,
        handler: async (ctx: Context) => ctx.json({ ok: true }),
      } as any,
    }

    const definition = createAuthTestDefinition({
      app: appDecl,
      auth: authDecl,
      routes: [meRoute],
    })

    const instance = await createApp(definition)

    try {
      vi.useFakeTimers()
      const now = Math.floor(Date.now() / 1000)
      // Token renewed on Day 4: original iat = now - 4 days, exp = now + 7 days
      // Now on Day 6: 2 days have passed since renewal.
      // Remaining = 5 days (432,000s). Configured half = 3.5 days (302,400s).
      // Since remaining 5 days > 3.5 days, it should NOT renew!
      // (If it incorrectly used (exp - iat) / 2, totalMs would be 11 days, half = 5.5 days, so 5 days < 5.5 days would falsely renew!)
      const initialIat = now - 4 * 86400
      const expDay11 = now + 5 * 86400 // 5 days remaining from now
      const token = await (async () => {
        const { sign } = await import('hono/jwt')
        return sign(
          {
            sub: 'drift-test',
            ver: 0,
            jti: 'fixed-jti',
            iat: initialIat,
            exp: expDay11,
          },
          TEST_SECRET,
          'HS256',
        )
      })()

      const res = await instance.fetch(
        new Request('http://localhost/api/check', {
          headers: { Cookie: `auth_token=${token}` },
        }),
      )
      expect(res.status).toBe(200)

      // Must NOT renew because 5 days remaining > 3.5 days
      const setCookie = res.headers.get('set-cookie')
      expect(setCookie).toBeNull()
    } finally {
      vi.useRealTimers()
      await instance.close()
    }
  })

  it('delivers renewed session cookie on real SSR page when remaining lifetime < expiresIn / 2', async () => {
    const { createElement } = await import('react')
    const { createPageHandler } = await import('../../src/page/server/handler')
    const { resolvePageConfig } = await import('../../src/page/config')

    const appDecl = defineApp({ hosts: 'localhost' })
    const authDecl = defineAuth({ secret: TEST_SECRET, expiresIn: 604_800_000, rolling: true })

    const dashboardPageHandler = createPageHandler(
      {
        pattern: '/dashboard',
        shapeKey: '/dashboard',
        paramNames: [],
        httpScopes: [],
        scopes: [
          {
            id: 'dashboard',
            component: () => createElement('h1', null, 'Welcome to Dashboard'),
          },
        ],
      },
      () => ({ bootstrapModules: [], stylesheets: [], routeStyles: {} }),
    )

    const pageRoute: RouteEntry = {
      kind: 'page',
      routePath: {
        urlPath: '/dashboard',
        clientPath: '/dashboard',
        shapeKey: '/dashboard',
        method: 'GET',
        segments: [{ kind: 'static', raw: 'dashboard' }],
        isSse: false,
        isWs: false,
      },
      pageHandler: dashboardPageHandler,
    }

    const definition = createAuthTestDefinition({
      app: appDecl,
      auth: authDecl,
      apiPrefix: '/api',
      createPageConfigResolver: () => (env: unknown) => resolvePageConfig(undefined, env, '/api'),
      routes: [pageRoute],
    })

    const instance = await createApp(definition)

    try {
      const now = Math.floor(Date.now() / 1000)
      // 7 days token = 604800s. Threshold = 302400s (3.5 days).
      // Create a token with 2 days remaining (172800s), which is < 3.5 days.
      const initialIat = now - 5 * 86400
      const exp = now + 2 * 86400

      const { sign } = await import('hono/jwt')
      const expiringToken = await sign(
        {
          sub: 'ssr-user',
          ver: 0,
          jti: 'ssr-jti-123',
          iat: initialIat,
          exp,
        },
        TEST_SECRET,
        'HS256',
      )

      const res = await instance.fetch(
        new Request('http://localhost/dashboard', {
          headers: { Cookie: `auth_token=${expiringToken}` },
        }),
      )

      expect(res.status).toBe(200)
      const html = await res.text()
      expect(html).toContain('Welcome to Dashboard')

      // Renewal must complete before SSR captures the outer response headers.
      const setCookie = res.headers.get('set-cookie')
      expect(setCookie).toBeTruthy()
      expect(setCookie).toContain('auth_token=')

      // Verify renewed token payload
      const renewedCookieVal = setCookie!.split(';')[0].replace('auth_token=', '')
      const { decode } = await import('hono/jwt')
      const renewedPayload = decode(renewedCookieVal).payload
      expect(renewedPayload.sub).toBe('ssr-user')
      expect(renewedPayload.jti).toBe('ssr-jti-123')
      expect(renewedPayload.exp!).toBeGreaterThan(exp)
    } finally {
      await instance.close()
    }
  })
})
