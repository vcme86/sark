import { Context } from 'hono'
import { parseSigned } from 'hono/utils/cookie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createWorkerHandler } from '../../src/adapter/cloudflare/runtime'
import { createApp } from '../../src/core/create'
import { createDefinition } from '../../src/core/definition'
import {
  defineOAuth,
  type OAuthDeclaration,
  type OAuthTokens,
  type UserProfile,
} from '../../src/entries/auth/oauth'
import { type AuthDeclaration, defineAuth } from '../../src/entries/auth/session'
import { type AppDeclaration, defineApp } from '../../src/entries/server'
import { parseApiFilePath } from '../../src/http/path'
import { createOAuthAssembly } from '../../src/services/auth/oauth/assembly'
import { resolveOAuthProviders } from '../../src/services/auth/oauth/config'
import { createAuthAssembly } from '../../src/services/auth/session/assembly'

/**
 * Contract tests for OAuth 2.0 and OIDC third-party authentication.
 */

const COOKIE_SECRET = 'super-secret-cookie-signing-key-123456!'

function createAuthTestDefinition(input: {
  app?: AppDeclaration
  auth?: AuthDeclaration
  oauth?: OAuthDeclaration
  routes?: any[]
  createPageConfigResolver?: () => (env: unknown) => unknown
  apiPrefix?: string
}) {
  const apiPrefix = input.apiPrefix ?? '/api'
  return createDefinition({
    app: input.app,
    services: {
      ...(input.auth ? { auth: createAuthAssembly(input.auth) } : {}),
      ...(input.oauth ? { oauth: createOAuthAssembly(input.oauth, apiPrefix) } : {}),
    },
    routes: input.routes,
    createPageConfigResolver: input.createPageConfigResolver,
    apiPrefix,
  })
}

const discoveryDocuments: Record<string, object> = {
  'https://accounts.google.com/.well-known/openid-configuration': {
    issuer: 'https://accounts.google.com',
    authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    token_endpoint: 'https://oauth2.googleapis.com/token',
    response_types_supported: ['code'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
  },
  'https://appleid.apple.com/.well-known/openid-configuration': {
    issuer: 'https://appleid.apple.com',
    authorization_endpoint: 'https://appleid.apple.com/auth/authorize',
    token_endpoint: 'https://appleid.apple.com/auth/token',
    response_types_supported: ['code'],
    subject_types_supported: ['pairwise'],
    id_token_signing_alg_values_supported: ['RS256'],
    token_endpoint_auth_methods_supported: ['client_secret_post'],
  },
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input)
      const document = discoveryDocuments[url]
      if (document) return Response.json(document)
      throw new Error(`Unexpected external request: ${url}`)
    }),
  )
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('OAuth 2.0 & OIDC Contract Tests', () => {
  it.each(['/api', '/service/v2', '/'])(
    'mounts default OAuth endpoints under %s while preserving application page paths and registered callbacks',
    async (apiPrefix) => {
      const instance = await createApp(
        createDefinition({
          apiPrefix,
          app: defineApp({ cookie: { secret: COOKIE_SECRET } }),
          services: {
            oauth: createOAuthAssembly(
              defineOAuth([
                {
                  id: 'github',
                  kind: 'github',
                  clientId: 'client',
                  clientSecret: 'secret',
                  scopes: [],
                  redirectUri: 'https://public.example.com/registered/callback?tenant=reader',
                  onSuccess() {},
                },
              ]),
              apiPrefix,
            ),
          },
          routes:
            apiPrefix === '/'
              ? []
              : [
                  {
                    kind: 'page',
                    routePath: parseApiFilePath('auth.github.signin.get.ts', '/')!,
                    pageHandler: async () =>
                      new Response('<h1>Sign in</h1>', {
                        headers: { 'Content-Type': 'text/html' },
                      }),
                  },
                ],
        }),
      )
      try {
        const prefix = apiPrefix === '/' ? '' : apiPrefix
        const signin = await instance.fetch(
          new Request(`http://localhost${prefix}/auth/github/signin`),
        )
        expect(signin.status).toBe(302)
        const authorization = new URL(signin.headers.get('Location')!)
        expect(authorization.searchParams.get('redirect_uri')).toBe(
          'https://public.example.com/registered/callback?tenant=reader',
        )
        expect(signin.headers.getSetCookie()[0]).toContain('Path=/registered/callback')
        if (apiPrefix !== '/') {
          const page = await instance.fetch(
            new Request('http://localhost/auth/github/signin', {
              headers: { Accept: 'text/html' },
            }),
          )
          expect(page.status).toBe(200)
          expect(await page.text()).toBe('<h1>Sign in</h1>')
        }
        const callback = await instance.fetch(
          new Request('http://localhost/registered/callback?tenant=reader'),
        )
        expect(callback.status).toBe(401)
        if (prefix) {
          const unintended = await instance.fetch(
            new Request(`http://localhost${prefix}/registered/callback`),
          )
          expect(unintended.status).toBe(404)
        }
      } finally {
        await instance.close()
      }
    },
  )

  it('enforces app.cookie.secret when OAuth is declared', async () => {
    const appDecl = defineApp({
      hosts: 'localhost',
      // cookie.secret is intentionally omitted
    })

    const oauthDecl = defineOAuth([
      {
        id: 'github',
        kind: 'github',
        clientId: 'gh-client-id',
        clientSecret: 'gh-client-secret',
        scopes: ['user:email'],
        redirectUri: 'http://localhost/api/auth/github/callback',
        onSuccess: () => {},
      },
    ])

    const definition = createAuthTestDefinition({
      app: appDecl,
      oauth: oauthDecl,
    })

    await expect(createApp(definition)).rejects.toThrow(/OAuth requires app\.cookie\.secret/)
  })

  it('detects and rejects route conflicts with user-declared routes', async () => {
    const appDecl = defineApp({
      hosts: 'localhost',
      cookie: { secret: COOKIE_SECRET },
    })

    const oauthDecl = defineOAuth([
      {
        id: 'google',
        kind: 'google',
        clientId: 'g-client-id',
        clientSecret: 'g-client-secret',
        scopes: ['openid', 'email'],
        redirectUri: 'http://localhost/api/auth/google/callback',
        onSuccess: () => {},
      },
    ])

    // User declares a route that collides with default GET /api/auth/google/signin
    const collidingRoute = {
      routePath: {
        urlPath: '/api/auth/google/signin',
        clientPath: '/api/auth/google/signin',
        shapeKey: '/api/auth/google/signin',
        method: 'GET',
        segments: [
          { kind: 'static', raw: 'api' },
          { kind: 'static', raw: 'auth' },
          { kind: 'static', raw: 'google' },
          { kind: 'static', raw: 'signin' },
        ],
        isSse: false,
        isWs: false,
      },
      kind: 'api' as const,
      declaration: {
        options: { middleware: [] },
        validators: {},
        isRoute: true as const,
        handler: async (ctx: Context) => ctx.text('custom signin'),
      },
    }

    const definition = createAuthTestDefinition({
      app: appDecl,
      oauth: oauthDecl,
      routes: [collidingRoute as any],
    })

    await expect(createApp(definition)).rejects.toThrow(
      /Route conflict: GET \/api\/auth\/google\/signin/,
    )

    // ALL remains a fallback for methods not occupied by the OAuth endpoint.
    const allCollidingRoute = {
      ...collidingRoute,
      routePath: {
        ...collidingRoute.routePath,
        method: 'ALL',
      },
    }
    const defAll = createAuthTestDefinition({
      app: appDecl,
      oauth: oauthDecl,
      routes: [allCollidingRoute as any],
    })
    const instance = await createApp(defAll)
    try {
      const signin = await instance.fetch(new Request('http://localhost/api/auth/google/signin'))
      expect(signin.status).toBe(302)
      const fallback = await instance.fetch(
        new Request('http://localhost/api/auth/google/signin', { method: 'OPTIONS' }),
      )
      expect(fallback.status).toBe(200)
      expect(await fallback.text()).toBe('custom signin')
    } finally {
      await instance.close()
    }
  })

  it('allows user-declared POST route on same path as OAuth GET callback', async () => {
    const appDecl = defineApp({
      hosts: 'localhost',
      cookie: { secret: COOKIE_SECRET },
    })

    const oauthDecl = defineOAuth([
      {
        id: 'github',
        kind: 'github',
        clientSecret: 'test-client-secret',
        clientId: 'gh-id',
        scopes: ['user'],
        redirectUri: 'http://localhost/api/auth/github/callback',
        onSuccess: () => {},
      },
    ])

    const userPostRoute = {
      routePath: {
        urlPath: '/api/auth/github/callback',
        clientPath: '/api/auth/github/callback',
        shapeKey: '/api/auth/github/callback',
        method: 'POST',
        segments: [
          { kind: 'static', raw: 'api' },
          { kind: 'static', raw: 'auth' },
          { kind: 'static', raw: 'github' },
          { kind: 'static', raw: 'callback' },
        ],
        isSse: false,
        isWs: false,
      },
      kind: 'api' as const,
      declaration: {
        options: { csrf: false, middleware: [] },
        validators: {},
        isRoute: true as const,
        handler: async (ctx: Context) => ctx.text('business post response'),
      },
    }

    const definition = createAuthTestDefinition({
      app: appDecl,
      oauth: oauthDecl,
      routes: [userPostRoute as any],
    })

    const instance = await createApp(definition)
    const res = await instance.fetch(
      new Request('http://localhost/api/auth/github/callback', {
        method: 'POST',
      }),
    )

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('business post response')
    await instance.close()
  })

  it('generates PKCE, state, and signed cookie on GET /api/auth/:id/signin', async () => {
    const appDecl = defineApp({
      hosts: 'localhost',
      cookie: { secret: COOKIE_SECRET },
    })

    const oauthDecl = defineOAuth([
      {
        id: 'github',
        kind: 'github',
        clientSecret: 'test-client-secret',
        clientId: 'my-github-client-id',
        scopes: ['read:user'],
        redirectUri: 'http://localhost/api/auth/github/callback',
        onSuccess: () => {},
      },
    ])

    const definition = createAuthTestDefinition({
      app: appDecl,
      oauth: oauthDecl,
    })

    const instance = await createApp(definition)

    const res = await instance.fetch(new Request('http://localhost/api/auth/github/signin'))
    expect(res.status).toBe(302)

    const location = res.headers.get('location')
    expect(location).toBeTruthy()
    const redirectUrl = new URL(location!)
    expect(redirectUrl.origin).toBe('https://github.com')
    expect(redirectUrl.pathname).toBe('/login/oauth/authorize')
    expect(redirectUrl.searchParams.get('client_id')).toBe('my-github-client-id')
    expect(redirectUrl.searchParams.get('redirect_uri')).toBe(
      'http://localhost/api/auth/github/callback',
    )
    expect(redirectUrl.searchParams.get('scope')).toBe('read:user')
    const stateParam = redirectUrl.searchParams.get('state')
    expect(stateParam).toBeTruthy()

    const setCookie = res.headers.get('set-cookie')
    expect(setCookie).toBeTruthy()
    expect(setCookie).toContain('__sark_oauth_github=')
    expect(setCookie).toContain('Path=/api/auth/github/callback')
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=Lax')

    const parsed = await parseSigned(setCookie!, COOKIE_SECRET, '__sark_oauth_github')
    const rawVal = parsed['__sark_oauth_github']
    expect(typeof rawVal).toBe('string')
    const tx = JSON.parse(rawVal as string)
    expect(tx.id).toBe('github')
    expect(tx.state).toBe(stateParam)
    expect(tx.redirectUri).toBe('http://localhost/api/auth/github/callback')

    await instance.close()
  })

  it('sets SameSite=None; Secure on state cookie for Apple form_post provider', async () => {
    const appDecl = defineApp({
      hosts: 'localhost',
      cookie: { secret: COOKIE_SECRET },
    })

    const oauthDecl = defineOAuth([
      {
        id: 'apple',
        kind: 'apple',
        clientSecret: 'test-client-secret',
        issuer: 'https://appleid.apple.com',
        clientId: 'com.example.service',
        scopes: ['openid', 'name', 'email'],
        redirectUri: 'https://app.example.com/api/auth/apple/callback',
        onSuccess: () => {},
      },
    ])

    const definition = createAuthTestDefinition({
      app: appDecl,
      oauth: oauthDecl,
    })

    const instance = await createApp(definition)

    const res = await instance.fetch(new Request('http://localhost/api/auth/apple/signin'))
    expect(res.status).toBe(302)

    const setCookie = res.headers.get('set-cookie')
    expect(setCookie).toBeTruthy()
    expect(setCookie).toContain('SameSite=None')
    expect(setCookie).toContain('Secure')

    await instance.close()
  })

  it('rejects callback when state cookie is missing, tampered, or mismatched', async () => {
    const appDecl = defineApp({
      hosts: 'localhost',
      cookie: { secret: COOKIE_SECRET },
    })

    const onErrorMock = vi.fn((err, ctx) => ctx.text('Custom Auth Error', 400))

    const oauthDecl = defineOAuth([
      {
        id: 'github',
        kind: 'github',
        clientSecret: 'test-client-secret',
        clientId: 'client-id',
        scopes: ['user'],
        redirectUri: 'http://localhost/api/auth/github/callback',
        onSuccess: () => {},
        onError: onErrorMock,
      },
    ])

    const definition = createAuthTestDefinition({
      app: appDecl,
      oauth: oauthDecl,
    })

    const instance = await createApp(definition)

    // 1. Missing cookie -> rejected
    const res1 = await instance.fetch(
      new Request('http://localhost/api/auth/github/callback?code=abc&state=xyz'),
    )
    expect(res1.status).toBe(400)
    expect(await res1.text()).toBe('Custom Auth Error')
    expect(onErrorMock).toHaveBeenCalled()

    // 2. Tampered cookie signature -> rejected
    const res2 = await instance.fetch(
      new Request('http://localhost/api/auth/github/callback?code=abc&state=xyz', {
        headers: {
          Cookie: '__sark_oauth_github=tampered_value.invalid_sig',
        },
      }),
    )
    expect(res2.status).toBe(400)

    // 3. Cookie state does not match callback query state -> rejected
    const loginRes = await instance.fetch(new Request('http://localhost/api/auth/github/signin'))
    const setCookie = loginRes.headers.get('set-cookie')!
    const cookieHeader = setCookie.split(';')[0]

    const res3 = await instance.fetch(
      new Request('http://localhost/api/auth/github/callback?code=abc&state=wrong_state', {
        headers: {
          Cookie: cookieHeader,
        },
      }),
    )
    expect(res3.status).toBe(400)

    await instance.close()
  })

  it('exempts Apple form_post callback from CSRF and handles provider errors', async () => {
    let capturedError: any
    const appDecl = defineApp({
      hosts: 'localhost',
      csrf: true,
      cookie: { secret: COOKIE_SECRET },
    })

    const oauthDecl = defineOAuth([
      {
        id: 'apple',
        kind: 'apple',
        clientSecret: 'test-client-secret',
        clientId: 'com.example.service',
        scopes: ['name', 'email'],
        redirectUri: 'http://localhost/api/auth/apple/callback',
        onSuccess: () => {},
        onError: (err, ctx) => {
          capturedError = err
          return ctx.json({ handledError: (err as Error).message }, 401)
        },
      },
    ])

    const definition = createAuthTestDefinition({
      app: appDecl,
      oauth: oauthDecl,
    })

    const instance = await createApp(definition)

    const loginRes = await instance.fetch(new Request('http://localhost/api/auth/apple/signin'))
    const setCookie = loginRes.headers.get('set-cookie')!
    const cookieHeader = setCookie.split(';')[0]

    const formData = new URLSearchParams()
    formData.append('error', 'user_cancelled_authorize')
    formData.append('state', new URL(loginRes.headers.get('location')!).searchParams.get('state')!)

    const callbackRes = await instance.fetch(
      new Request('http://localhost/api/auth/apple/callback', {
        method: 'POST',
        headers: {
          Origin: 'https://appleid.apple.com',
          Cookie: cookieHeader,
        },
        body: formData,
      }),
    )

    expect(callbackRes.status).toBe(401)
    expect(capturedError.error).toBe('user_cancelled_authorize')
    expect(capturedError).toBeDefined()

    await instance.close()
  })

  it('completes GitHub OAuth code exchange and maps UserProfile', async () => {
    const appDecl = defineApp({
      hosts: 'localhost',
      cookie: { secret: COOKIE_SECRET },
    })

    let capturedProfile: UserProfile | undefined
    let capturedTokens: OAuthTokens | undefined

    const oauthDecl = defineOAuth([
      {
        id: 'github',
        kind: 'github',
        clientId: 'gh-id',
        clientSecret: 'gh-secret',
        scopes: ['read:user', 'user:email'],
        redirectUri: 'http://localhost/api/auth/github/callback',
        onSuccess: (profile, tokens, ctx) => {
          capturedProfile = profile
          capturedTokens = tokens
          return ctx.json({ loggedIn: true, user: profile.name })
        },
      },
    ])

    const definition = createAuthTestDefinition({
      app: appDecl,
      oauth: oauthDecl,
    })

    const instance = await createApp(definition)

    const loginRes = await instance.fetch(new Request('http://localhost/api/auth/github/signin'))
    const setCookie = loginRes.headers.get('set-cookie')!
    const cookieHeader = setCookie.split(';')[0]
    const stateParam = new URL(loginRes.headers.get('location')!).searchParams.get('state')!

    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url

      if (url === 'https://github.com/login/oauth/access_token') {
        return new Response(
          JSON.stringify({
            access_token: 'gho_dummy_token_123',
            token_type: 'bearer',
            scope: 'read:user,user:email',
          }),
          { headers: { 'Content-Type': 'application/json' } },
        )
      }

      if (url === 'https://api.github.com/user') {
        return new Response(
          JSON.stringify({
            id: 123456,
            login: 'octocat',
            name: 'Mona Lisa Octocat',
            avatar_url: 'https://github.com/images/error/octocat_happy.gif',
            email: null,
          }),
          { headers: { 'Content-Type': 'application/json' } },
        )
      }

      if (url === 'https://api.github.com/user/emails') {
        return new Response(
          JSON.stringify([
            { email: 'octocat@github.com', primary: true, verified: true },
            { email: 'unverified@github.com', primary: false, verified: false },
          ]),
          { headers: { 'Content-Type': 'application/json' } },
        )
      }

      return originalFetch(input, init)
    }) as any

    try {
      const callbackRes = await instance.fetch(
        new Request(
          `http://localhost/api/auth/github/callback?code=mock_code_123&state=${stateParam}`,
          {
            headers: {
              Cookie: cookieHeader,
            },
          },
        ),
      )

      expect(callbackRes.status).toBe(200)
      const resJson = (await callbackRes.json()) as any
      expect(resJson.loggedIn).toBe(true)
      expect(resJson.user).toBe('Mona Lisa Octocat')

      expect(capturedProfile).toBeDefined()
      expect(capturedProfile?.provider).toBe('github')
      expect(capturedProfile?.subject).toBe('123456')
      expect(capturedProfile?.name).toBe('Mona Lisa Octocat')
      expect(capturedProfile?.email).toBe('octocat@github.com')
      expect(capturedProfile?.emailVerified).toBe(true)
      expect(capturedProfile?.picture).toBe('https://github.com/images/error/octocat_happy.gif')

      expect(capturedTokens).toBeDefined()
      expect(capturedTokens?.accessToken).toBe('gho_dummy_token_123')
      expect(capturedTokens?.tokenType).toBe('bearer')

      const clearCookie = callbackRes.headers.get('set-cookie')
      expect(clearCookie).toContain('Max-Age=0')
    } finally {
      globalThis.fetch = originalFetch
      await instance.close()
    }
  })

  it('supports Workers per-event OAuth configuration via createWorkerHandler without premature failure', async () => {
    const appDecl = defineApp((env: { SECRET?: string }) => ({
      hosts: 'localhost',
      cookie: { secret: env.SECRET },
    }))

    const oauthDecl = defineOAuth((env: { GH_ID: string; GH_SECRET: string }) => [
      {
        id: 'github',
        kind: 'github' as const,
        clientId: env.GH_ID,
        clientSecret: env.GH_SECRET,
        scopes: ['read:user'],
        redirectUri: 'http://localhost/api/auth/github/callback',
        onSuccess: () => {},
      },
    ])

    const definition = createAuthTestDefinition({
      app: appDecl,
      oauth: oauthDecl,
    })

    const handler = createWorkerHandler(definition, true)
    const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() }

    // Event 1 with Tenant 1 credentials
    const env1 = {
      SECRET: 'tenant-1-cookie-signing-secret-long!',
      GH_ID: 'gh-tenant-1',
      GH_SECRET: 'secret-tenant-1',
    }
    const res1 = await handler.fetch(
      new Request('http://localhost/api/auth/github/signin'),
      env1,
      ctx as any,
    )
    expect(res1.status).toBe(302)
    const loc1 = res1.headers.get('location')!
    expect(new URL(loc1).searchParams.get('client_id')).toBe('gh-tenant-1')

    // Event 2 with Tenant 2 credentials
    const env2 = {
      SECRET: 'tenant-2-cookie-signing-secret-long!',
      GH_ID: 'gh-tenant-2',
      GH_SECRET: 'secret-tenant-2',
    }
    const res2 = await handler.fetch(
      new Request('http://localhost/api/auth/github/signin'),
      env2,
      ctx as any,
    )
    expect(res2.status).toBe(302)
    const loc2 = res2.headers.get('location')!
    expect(new URL(loc2).searchParams.get('client_id')).toBe('gh-tenant-2')

    // Event 3 with missing cookie secret -> fails cleanly per event without crashing worker instance
    const env3 = {
      GH_ID: 'gh-tenant-3',
      GH_SECRET: 'secret-tenant-3',
    }
    const res3 = await handler.fetch(
      new Request('http://localhost/api/auth/github/signin'),
      env3 as any,
      ctx as any,
    )
    expect(res3.status).toBe(500)
  })

  it('supports structured env (e.g. env.github.clientId) in OAuth factory on Workers without mock proxy', async () => {
    interface StructuredEnv {
      cookieSecret: string
      github: {
        clientId: string
        clientSecret: string
      }
    }

    const appDecl = defineApp((env: StructuredEnv) => ({
      hosts: 'localhost',
      cookie: { secret: env.cookieSecret },
    }))

    const oauthDecl = defineOAuth((env: StructuredEnv) => [
      {
        id: 'github',
        kind: 'github' as const,
        clientId: env.github.clientId,
        clientSecret: env.github.clientSecret,
        scopes: ['read:user'],
        redirectUri: 'http://localhost/api/auth/github/callback',
        onSuccess: () => {},
      },
    ])

    const definition = createAuthTestDefinition({
      app: appDecl,
      oauth: oauthDecl,
    })

    const handler = createWorkerHandler(definition, true)
    const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() }

    const realEnv: StructuredEnv = {
      cookieSecret: 'long-secret-key-for-cookie-signing-12345!',
      github: {
        clientId: 'structured-gh-client-id',
        clientSecret: 'structured-gh-secret',
      },
    }

    const res = await handler.fetch(
      new Request('http://localhost/api/auth/github/signin'),
      realEnv,
      ctx as any,
    )
    expect(res.status).toBe(302)
    const location = res.headers.get('location')!
    expect(new URL(location).searchParams.get('client_id')).toBe('structured-gh-client-id')
  })

  it.each([
    'http://localhost/api/auth/github/callback?source=community&version=2',
    'http://localhost:80/api/auth/github/callback',
    'http://LOCALHOST/api/auth/github/callback',
    'http://localhost/api/auth/github/callback',
  ])(
    'preserves the exact registered redirect URI during token exchange: %s',
    async (registeredRedirectUri) => {
      const appDecl = defineApp({
        hosts: 'localhost',
        cookie: { secret: COOKIE_SECRET },
      })

      let tokenRequestBody: string | undefined

      const oauthDecl = defineOAuth([
        {
          id: 'github',
          kind: 'github',
          clientId: 'gh-id',
          clientSecret: 'gh-secret',
          scopes: ['read:user'],
          redirectUri: registeredRedirectUri,
          onSuccess: (_p, _t, ctx) => ctx.json({ ok: true }),
        },
      ])

      const definition = createAuthTestDefinition({
        app: appDecl,
        oauth: oauthDecl,
      })

      const instance = await createApp(definition)

      const loginRes = await instance.fetch(new Request('http://localhost/api/auth/github/signin'))
      const setCookie = loginRes.headers.get('set-cookie')!
      const cookieHeader = setCookie.split(';')[0]
      const authorization = new URL(loginRes.headers.get('location')!)
      expect(authorization.searchParams.get('redirect_uri')).toBe(registeredRedirectUri)
      const stateParam = authorization.searchParams.get('state')!

      const originalFetch = globalThis.fetch
      globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url

        if (url === 'https://github.com/login/oauth/access_token') {
          tokenRequestBody = init?.body?.toString()
          return new Response(
            JSON.stringify({
              access_token: 'gho_token_with_query_preserved',
              token_type: 'bearer',
              scope: 'read:user',
            }),
            { headers: { 'Content-Type': 'application/json' } },
          )
        }

        if (url === 'https://api.github.com/user') {
          return new Response(
            JSON.stringify({ id: 999, login: 'query-user', name: 'Query User' }),
            {
              headers: { 'Content-Type': 'application/json' },
            },
          )
        }

        return originalFetch(input, init)
      }) as any

      try {
        const callbackUrl = new URL(registeredRedirectUri)
        callbackUrl.searchParams.set('code', 'test_code')
        callbackUrl.searchParams.set('state', stateParam)
        const callbackRes = await instance.fetch(
          new Request(callbackUrl, {
            headers: { Cookie: cookieHeader },
          }),
        )
        expect(callbackRes.status).toBe(200)

        expect(tokenRequestBody).toBeDefined()
        const params = new URLSearchParams(tokenRequestBody!)
        expect(params.get('grant_type')).toBe('authorization_code')
        expect(params.get('redirect_uri')).toBe(registeredRedirectUri)
      } finally {
        globalThis.fetch = originalFetch
        await instance.close()
      }
    },
  )

  it('evaluates Auth and OAuth factories exactly once per Node instance', async () => {
    let authFactoryCount = 0
    let oauthFactoryCount = 0

    const appDecl = defineApp({
      hosts: 'localhost',
      cookie: { secret: COOKIE_SECRET },
    })

    const authDecl = defineAuth((_env) => {
      authFactoryCount++
      return {
        secret: 'a-very-long-secret-key-of-at-least-32-characters-123',
      }
    })

    const oauthDecl = defineOAuth((_env) => {
      oauthFactoryCount++
      return [
        {
          id: 'github',
          kind: 'github' as const,
          clientSecret: 'test-client-secret',
          clientId: 'gh-id',
          scopes: ['user'],
          redirectUri: 'http://localhost/api/auth/github/callback',
          onSuccess: () => {},
        },
      ]
    })

    const definition = createAuthTestDefinition({
      app: appDecl,
      auth: authDecl,
      oauth: oauthDecl,
    })

    const instance = await createApp(definition, { env: {} })

    expect(authFactoryCount).toBe(1)
    expect(oauthFactoryCount).toBe(1)

    const res = await instance.fetch(new Request('http://localhost/api/auth/github/signin'))
    expect(res.status).toBe(302)
    expect(authFactoryCount).toBe(1)
    expect(oauthFactoryCount).toBe(1)

    await instance.close()
  })

  it('rejects POST on callback route for non-Apple provider with 405 Method Not Allowed and Allow header', async () => {
    const appDecl = defineApp((env: { SECRET: string }) => ({
      hosts: 'localhost',
      cookie: { secret: env.SECRET },
    }))

    const oauthDecl = defineOAuth((_env) => [
      {
        id: 'github',
        kind: 'github' as const,
        clientSecret: 'test-client-secret',
        clientId: 'gh-id',
        scopes: ['user'],
        redirectUri: 'http://localhost/api/auth/github/callback',
        onSuccess: () => {},
      },
    ])

    const definition = createAuthTestDefinition({
      app: appDecl,
      oauth: oauthDecl,
    })

    const handler = createWorkerHandler(definition, true)
    const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() }
    const env = { SECRET: COOKIE_SECRET }

    const postRes = await handler.fetch(
      new Request('http://localhost/api/auth/github/callback', {
        method: 'POST',
      }),
      env,
      ctx as any,
    )
    expect(postRes.status).toBe(405)
    expect(postRes.headers.get('allow')).toContain('GET')
  })

  it('completes a slash-terminated callback through the common URL policy without losing its cookie', async () => {
    const instance = await createApp(
      createAuthTestDefinition({
        app: defineApp({ cookie: { secret: COOKIE_SECRET } }),
        oauth: defineOAuth([
          {
            id: 'github',
            kind: 'github',
            clientId: 'client',
            clientSecret: 'secret',
            scopes: [],
            signInPath: '/signin/',
            redirectUri: 'https://public.example.com/callback/',
            onSuccess(profile, _tokens, ctx) {
              return ctx.json({ subject: profile.subject })
            },
          },
        ]),
      }),
    )
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === 'https://github.com/login/oauth/access_token') {
        expect(new URLSearchParams(init!.body as URLSearchParams).get('redirect_uri')).toBe(
          'https://public.example.com/callback/',
        )
        return Response.json({ access_token: 'github-token', token_type: 'Bearer' })
      }
      if (String(input) === 'https://api.github.com/user')
        return Response.json({ id: 42, login: 'reader', email: 'reader@example.com' })
      throw new Error(`Unexpected provider request: ${String(input)}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      const signin = await instance.fetch(new Request('https://public.example.com/signin'))
      expect(signin.status).toBe(302)
      const cookie = signin.headers.getSetCookie()[0]
      expect(cookie).toContain('Path=/callback;')
      const state = new URL(signin.headers.get('Location')!).searchParams.get('state')!
      const canonical = await instance.fetch(new Request('http://localhost/signin/'))
      expect(canonical.status).toBe(308)
      expect(new URL(canonical.headers.get('Location')!).pathname).toBe('/signin')
      const callback = await instance.fetch(
        new Request(`https://public.example.com/callback/?code=single-use&state=${state}`, {
          headers: { Cookie: cookie.split(';')[0] },
        }),
      )
      expect(callback.status).toBe(308)
      const location = callback.headers.get('Location')!
      expect(new URL(location).pathname).toBe('/callback')
      // The resolved Cookie Path matches both the registered and canonical callback paths.
      const completed = await instance.fetch(
        new Request(location, { headers: { Cookie: cookie.split(';')[0] } }),
      )
      expect(completed.status).toBe(200)
      expect(await completed.json()).toEqual({ subject: '42' })
      expect(completed.headers.getSetCookie()[0]).toContain('Path=/callback;')
      expect(completed.headers.getSetCookie()[0]).toContain('Max-Age=0')
    } finally {
      await instance.close()
    }
  })

  it.each(['snsapi_login', 'snsapi_userinfo'])(
    'completes WeChat %s without forcing OIDC or PKCE',
    async (scope) => {
      const onSuccess = vi.fn((profile, tokens, ctx) => ctx.json({ profile, tokens }))
      const instance = await createApp(
        createAuthTestDefinition({
          app: defineApp({ cookie: { secret: COOKIE_SECRET } }),
          oauth: defineOAuth([
            {
              id: 'wechat',
              kind: 'wechat',
              clientId: 'wx-client',
              clientSecret: 'wx-secret',
              scopes: [scope],
              redirectUri: 'https://public.example.com/api/auth/wechat/callback',
              onSuccess,
            },
          ]),
        }),
      )
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input))
        if (url.pathname === '/sns/oauth2/access_token') {
          expect(url.searchParams.get('appid')).toBe('wx-client')
          expect(url.searchParams.get('secret')).toBe('wx-secret')
          expect(url.searchParams.get('code')).toBe('wechat-code')
          return Response.json({
            access_token: 'wx-access',
            openid: 'wx-subject',
            expires_in: 7200,
          })
        }
        expect(url.pathname).toBe('/sns/userinfo')
        expect(url.searchParams.get('openid')).toBe('wx-subject')
        return Response.json({ nickname: 'Reader', headimgurl: 'https://example.com/avatar.png' })
      })
      vi.stubGlobal('fetch', fetchMock)
      try {
        const login = await instance.fetch(new Request('http://localhost/api/auth/wechat/signin'))
        const url = new URL(login.headers.get('Location')!)
        expect(url.pathname).toBe(
          scope === 'snsapi_login' ? '/connect/qrconnect' : '/connect/oauth2/authorize',
        )
        expect(url.searchParams.has('code_challenge')).toBe(false)
        const response = await instance.fetch(
          new Request(
            `http://localhost/api/auth/wechat/callback?code=wechat-code&state=${url.searchParams.get('state')}`,
            {
              headers: { Cookie: login.headers.getSetCookie()[0].split(';')[0] },
            },
          ),
        )
        expect(response.status).toBe(200)
        expect((await response.json()).profile).toMatchObject({
          subject: 'wx-subject',
          name: 'Reader',
        })
        expect(fetchMock).toHaveBeenCalledTimes(2)
      } finally {
        await instance.close()
      }
    },
  )

  it('enforces Google preset constraints and allows custom signInPath/callbackPath', async () => {
    const appDecl = defineApp({
      hosts: 'localhost',
      cookie: { secret: COOKIE_SECRET },
    })

    // 1. Google preset rejects issuer override
    expect(() =>
      resolveOAuthProviders(
        [
          {
            id: 'google',
            kind: 'google',
            issuer: 'https://custom-issuer.example.com',
            clientId: 'g-client',
            scopes: ['openid'],
            redirectUri: 'http://localhost/api/auth/google/callback',
            onSuccess: () => {},
          },
        ],
        undefined,
        '/api',
      ),
    ).toThrow(/does not accept an issuer override/)

    // 2. Google preset requires 'openid'
    expect(() =>
      resolveOAuthProviders(
        [
          {
            id: 'google',
            kind: 'google',
            clientId: 'g-client',
            scopes: ['email', 'profile'],
            redirectUri: 'http://localhost/api/auth/google/callback',
            onSuccess: () => {},
          },
        ],
        undefined,
        '/api',
      ),
    ).toThrow(/requires "openid" in scopes/)

    // 3. Custom signInPath and callbackPath
    const oauthDecl = defineOAuth([
      {
        id: 'my-google',
        kind: 'google',
        clientId: 'google-client-id',
        scopes: ['openid', 'email'],
        signInPath: '/account/google/signin',
        callbackPath: '/account/google/callback',
        redirectUri: 'https://public.example.com/auth/google/callback',
        onSuccess: () => {},
      },
    ])

    const definition = createAuthTestDefinition({
      app: appDecl,
      oauth: oauthDecl,
    })

    const instance = await createApp(definition)

    // GET /account/google/signin redirects to Google auth
    const signinRes = await instance.fetch(new Request('http://localhost/account/google/signin'))
    expect(signinRes.status).toBe(302)

    // State cookie path uses the explicitly registered public pathname: /auth/google/callback
    const setCookie = signinRes.headers.get('set-cookie')!
    expect(setCookie).toContain('Path=/auth/google/callback')

    // Local custom callback is mounted at /account/google/callback
    const callbackRes = await instance.fetch(
      new Request('http://localhost/account/google/callback'),
    )
    // Fails with missing cookie (401), not 404!
    expect(callbackRes.status).toBe(401)

    // Default paths /api/auth/my-google/signin are not registered
    const defaultRes = await instance.fetch(
      new Request('http://localhost/api/auth/my-google/signin'),
    )
    expect(defaultRes.status).toBe(404)

    await instance.close()
  })
})

it('returns the common error envelope and clears the transaction on callback failure', async () => {
  const onSuccess = vi.fn()
  const instance = await createApp(
    createAuthTestDefinition({
      app: defineApp({ cookie: { secret: COOKIE_SECRET } }),
      oauth: defineOAuth([
        {
          id: 'github',
          kind: 'github',
          clientId: 'client',
          clientSecret: 'secret',
          scopes: [],
          redirectUri: 'http://localhost/api/auth/github/callback',
          onSuccess,
        },
      ]),
    }),
  )
  try {
    const response = await instance.fetch(
      new Request('http://localhost/api/auth/github/callback?error=access_denied'),
    )
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({
      error: { code: 'oauth_failed', message: 'OAuth authorization failed' },
    })
    expect(response.headers.getSetCookie().join(';')).toContain('__sark_oauth_github=')
    expect(response.headers.getSetCookie().join(';')).toContain('Max-Age=0')
    expect(onSuccess).not.toHaveBeenCalled()
  } finally {
    await instance.close()
  }
})

it.each([
  {
    name: 'an invalid grant',
    response: () => Response.json({ error: 'invalid_grant' }, { status: 400 }),
    status: 401,
  },
  {
    name: 'a rejected client secret',
    response: () => Response.json({ error: 'invalid_client' }, { status: 401 }),
    status: 500,
  },
  {
    name: 'an unavailable provider',
    response: () => new Response(null, { status: 503 }),
    status: 500,
  },
  {
    name: 'an incomplete token response',
    response: () => Response.json({ token_type: 'Bearer' }),
    status: 500,
  },
  {
    name: 'a rejected profile token',
    response: () => Response.json({ access_token: 'token', token_type: 'Bearer' }),
    profileStatus: 401,
    status: 401,
  },
  {
    name: 'a failed profile endpoint',
    response: () => Response.json({ access_token: 'token', token_type: 'Bearer' }),
    profileStatus: 503,
    status: 500,
  },
])('distinguishes $name from other OAuth failures', async ({ response, profileStatus, status }) => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === 'https://github.com/login/oauth/access_token') return response()
      if (String(input) === 'https://api.github.com/user')
        return new Response(null, { status: profileStatus })
      throw new Error(`Unexpected request: ${String(input)}`)
    }),
  )
  const onSuccess = vi.fn()
  const instance = await createApp(
    createAuthTestDefinition({
      app: defineApp({ cookie: { secret: COOKIE_SECRET } }),
      oauth: defineOAuth([
        {
          id: 'github',
          kind: 'github',
          clientId: 'client',
          clientSecret: 'secret',
          scopes: [],
          redirectUri: 'http://localhost/api/auth/github/callback',
          onSuccess,
        },
      ]),
    }),
  )
  try {
    const signin = await instance.fetch(new Request('http://localhost/api/auth/github/signin'))
    const state = new URL(signin.headers.get('Location')!).searchParams.get('state')!
    const callback = await instance.fetch(
      new Request(`http://localhost/api/auth/github/callback?code=code&state=${state}`, {
        headers: { Cookie: signin.headers.getSetCookie()[0].split(';')[0] },
      }),
    )
    expect(callback.status).toBe(status)
    expect((await callback.json()).error.code).toBe(
      status === 401 ? 'oauth_failed' : 'internal_server_error',
    )
    expect(callback.headers.getSetCookie().join(';')).toContain('Max-Age=0')
    expect(log).toHaveBeenCalledTimes(status === 500 ? 1 : 0)
    expect(onSuccess).not.toHaveBeenCalled()
  } finally {
    await instance.close()
  }
})

it.each([false, true])(
  'preserves discovery failures with custom handling set to %s',
  async (custom) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const failure = new Error('network unavailable')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw failure
      }),
    )
    const onError = vi.fn((error: unknown, ctx: Context) => ctx.text('Provider unavailable', 503))
    const instance = await createApp(
      createAuthTestDefinition({
        app: defineApp({ cookie: { secret: COOKIE_SECRET } }),
        oauth: defineOAuth([
          {
            id: 'google',
            kind: 'google',
            clientId: 'client',
            clientSecret: 'secret',
            scopes: ['openid'],
            redirectUri: 'http://localhost/api/auth/google/callback',
            onSuccess() {},
            ...(custom ? { onError } : {}),
          },
        ]),
      }),
    )
    try {
      const response = await instance.fetch(new Request('http://localhost/api/auth/google/signin'))
      expect(response.status).toBe(custom ? 503 : 500)
      if (custom) expect(onError.mock.calls[0][0]).toMatchObject({ cause: { cause: failure } })
      else expect((await response.json()).error.code).toBe('internal_server_error')
    } finally {
      await instance.close()
    }
  },
)

it.each(['mismatched state', 'access_denied', 'server_error'])(
  'handles an authorization callback with %s before token exchange',
  async (failure) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetch = vi.mocked(globalThis.fetch)
    const instance = await createApp(
      createAuthTestDefinition({
        app: defineApp({ cookie: { secret: COOKIE_SECRET } }),
        oauth: defineOAuth([
          {
            id: 'github',
            kind: 'github',
            clientId: 'client',
            clientSecret: 'secret',
            scopes: [],
            redirectUri: 'http://localhost/api/auth/github/callback',
            onSuccess() {},
          },
        ]),
      }),
    )
    try {
      const signin = await instance.fetch(new Request('http://localhost/api/auth/github/signin'))
      const callback = new URL('http://localhost/api/auth/github/callback')
      const state = new URL(signin.headers.get('Location')!).searchParams.get('state')!
      callback.searchParams.set('state', failure === 'mismatched state' ? 'different' : state)
      if (failure === 'mismatched state') callback.searchParams.set('code', 'code')
      else callback.searchParams.set('error', failure)
      const response = await instance.fetch(
        new Request(callback, {
          headers: { Cookie: signin.headers.getSetCookie()[0].split(';')[0] },
        }),
      )
      expect(response.status).toBe(failure === 'server_error' ? 500 : 401)
      expect((await response.json()).error.code).toBe(
        failure === 'server_error' ? 'internal_server_error' : 'oauth_failed',
      )
      expect(fetch).not.toHaveBeenCalled()
    } finally {
      await instance.close()
    }
  },
)
