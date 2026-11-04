import { HTTPException } from 'hono/http-exception'
import { sign } from 'hono/jwt'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { createApp } from '../../src/app/create'
import { createDefinition } from '../../src/app/definition'
import { defineOAuth, type OAuthProviderConfig } from '../../src/entries/auth/oauth'
import { defineApp } from '../../src/entries/root'
import { createOAuthAssembly } from '../../src/features/auth/oauth/assembly'

const secret = 'oauth-transaction-cookie-secret-123456'
let signingKey: CryptoKey
const applications: { close(): Promise<void> }[] = []

beforeAll(async () => {
  signingKey = (
    await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      false,
      ['sign', 'verify'],
    )
  ).privateKey
})
afterEach(async () => {
  await Promise.all(applications.splice(0).map((app) => app.close()))
  vi.unstubAllGlobals()
})

interface IdpOptions {
  kind?: OAuthProviderConfig['kind']
  failDiscovery?: boolean
  wrongNonce?: boolean
  wrongSubject?: boolean
  missingIdToken?: boolean
  omitAppleUser?: boolean
  appleUser?: { name?: { firstName?: unknown; lastName?: unknown }; email?: unknown }
  claims?: Record<string, unknown>
  userinfo?: Record<string, unknown>
}

/** A protocol fixture, not a mock of openid-client: it checks the actual authorization-code exchange. */
async function createIdp(options: IdpOptions = {}) {
  const kind = options.kind ?? 'oidc'
  const issuer =
    kind === 'google'
      ? 'https://accounts.google.com'
      : kind === 'apple'
        ? 'https://appleid.apple.com'
        : kind === 'microsoft'
          ? 'https://login.microsoftonline.com/common/v2.0'
          : 'https://idp.test'
  const tokenIssuer =
    kind === 'microsoft' ? 'https://login.microsoftonline.com/tenant-42/v2.0' : issuer
  const metadata = {
    issuer: kind === 'microsoft' ? 'https://login.microsoftonline.com/{tenantid}/v2.0' : issuer,
    authorization_endpoint:
      kind === 'microsoft'
        ? 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize'
        : `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    ...(kind !== 'apple' ? { userinfo_endpoint: `${issuer}/userinfo` } : {}),
    token_endpoint_auth_methods_supported:
      kind === 'apple' ? ['client_secret_post'] : ['client_secret_basic'],
    id_token_signing_alg_values_supported: ['RS256'],
    response_types_supported: ['code'],
    subject_types_supported: ['public'],
  }
  const onSuccess = vi.fn<OAuthProviderConfig['onSuccess']>((profile) => Response.json(profile))
  const onError = vi.fn<NonNullable<OAuthProviderConfig['onError']>>(
    () => new Response('authorization failed', { status: 401 }),
  )
  let authorization: URL
  let discoveries = 0
  let exchanges = 0
  let exchangedRedirect: string | null = null
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    if (url === `${issuer}/.well-known/openid-configuration`) {
      discoveries++
      if (options.failDiscovery && discoveries === 1) return new Response(null, { status: 503 })
      return Response.json(metadata)
    }
    if (url === metadata.token_endpoint) {
      exchanges++
      const body = new URLSearchParams(init!.body as URLSearchParams)
      expect(body.get('grant_type')).toBe('authorization_code')
      expect(body.get('code')).toBe('single-use-code')
      if (kind === 'apple') {
        expect(body.has('code_verifier')).toBe(false)
      } else {
        expect(body.get('code_verifier')).toBeTruthy()
        const digest = await crypto.subtle.digest(
          'SHA-256',
          new TextEncoder().encode(body.get('code_verifier')!),
        )
        const challenge = Buffer.from(digest).toString('base64url')
        expect(challenge).toBe(authorization.searchParams.get('code_challenge'))
      }
      exchangedRedirect = body.get('redirect_uri')
      if (kind === 'apple') {
        expect(body.get('client_secret')).toBe('client-secret')
      } else {
        const basic = new Headers(init!.headers).get('Authorization')!
        expect(basic.startsWith('Basic ')).toBe(true)
        expect(atob(basic.slice(6)).split(':').map(decodeURIComponent)).toEqual([
          'client-id',
          'client-secret',
        ])
        expect(body.has('client_secret')).toBe(false)
      }
      const now = Math.floor(Date.now() / 1000)
      return Response.json({
        access_token: 'access-token',
        token_type: 'Bearer',
        expires_in: 3600,
        ...(!options.missingIdToken
          ? {
              id_token: await sign(
                {
                  iss: tokenIssuer,
                  aud: 'client-id',
                  sub: 'external-user',
                  iat: now,
                  exp: now + 3600,
                  nonce: options.wrongNonce
                    ? 'wrong-nonce'
                    : authorization.searchParams.get('nonce'),
                  ...(kind === 'microsoft' ? { tid: 'tenant-42' } : {}),
                  ...(kind === 'apple'
                    ? { email: 'reader@example.com', email_verified: 'true' }
                    : {}),
                  ...options.claims,
                },
                signingKey,
                'RS256',
              ),
            }
          : {}),
      })
    }
    if (url === metadata.userinfo_endpoint) {
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer access-token')
      return Response.json({
        sub: options.wrongSubject ? 'another-user' : 'external-user',
        name: 'Protocol User',
        ...options.userinfo,
      })
    }
    throw new Error(`Unexpected protocol request: ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  const redirectUri = 'https://public.test/account/callback?channel=reader'
  const oauth = defineOAuth([
    {
      id: 'external',
      kind,
      ...(kind === 'oidc' ? { issuer } : {}),
      clientId: 'client-id',
      clientSecret: 'client-secret',
      scopes: ['openid', 'email'],
      signInPath: '/signin',
      callbackPath: '/internal/callback',
      redirectUri,
      onSuccess,
      onError,
    },
  ])
  const app = await createApp(
    createDefinition({
      app: defineApp({ cookie: { secret } }),
      services: { oauth: createOAuthAssembly(oauth, '/api') },
    }),
  )
  applications.push(app)
  async function begin() {
    const response = await app.fetch(new Request('https://local.test/signin'))
    if (response.status === 302) authorization = new URL(response.headers.get('Location')!)
    return response
  }
  async function finish(login: Response) {
    const state = authorization.searchParams.get('state')!
    const cookie = login.headers.getSetCookie()[0].split(';')[0]
    const params = new URLSearchParams({ code: 'single-use-code', state })
    const formPost = kind === 'apple'
    if (formPost && !options.omitAppleUser)
      params.set(
        'user',
        JSON.stringify(
          options.appleUser ?? {
            name: { firstName: 'Apple', lastName: 'User' },
            email: 'reader@example.com',
          },
        ),
      )
    const response = await app.fetch(
      new Request(
        `https://local.test/internal/callback${formPost ? '?channel=reader' : '?channel=reader&' + params}`,
        {
          method: formPost ? 'POST' : 'GET',
          headers: { Cookie: cookie, ...(formPost ? { Origin: 'https://appleid.apple.com' } : {}) },
          ...(formPost ? { body: params } : {}),
        },
      ),
    )
    return response
  }
  return {
    app,
    begin,
    finish,
    onSuccess,
    onError,
    fetchMock,
    redirectUri,
    get authorization() {
      return authorization
    },
    get discoveries() {
      return discoveries
    },
    get exchanges() {
      return exchanges
    },
    get exchangedRedirect() {
      return exchangedRedirect
    },
  }
}

it.each([
  {
    name: 'different addresses',
    claims: { email: 'old@example.com' },
    userinfo: { email: 'new@example.com', email_verified: true },
    expected: { email: 'old@example.com' },
  },
  {
    name: 'matching addresses',
    claims: { email: 'reader@example.com' },
    userinfo: { email: 'reader@example.com', email_verified: true },
    expected: { email: 'reader@example.com', emailVerified: true },
  },
  {
    name: 'explicit token verification',
    claims: { email: 'reader@example.com', email_verified: false },
    userinfo: { email: 'reader@example.com', email_verified: true },
    expected: { email: 'reader@example.com', emailVerified: false },
  },
  {
    name: 'UserInfo-only email',
    claims: {},
    userinfo: { email: 'reader@example.com', email_verified: true },
    expected: { email: 'reader@example.com', emailVerified: true },
  },
])(
  'keeps OIDC email verification bound to its address: $name',
  async ({ claims, userinfo, expected }) => {
    const fixture = await createIdp({ claims, userinfo })
    const response = await fixture.finish(await fixture.begin())
    expect(response.status).toBe(200)
    const profile = await response.json()
    expect(profile.email).toBe(expected.email)
    expect(profile.emailVerified).toBe(
      'emailVerified' in expected ? expected.emailVerified : undefined,
    )
  },
)

describe('OIDC protocol integration', () => {
  it.each(['oidc', 'google', 'microsoft', 'apple'] as const)(
    'completes %s using discovery, nonce, provider-specific PKCE and the registered redirect URI',
    async (kind) => {
      const idp = await createIdp({ kind })
      const login = await idp.begin()
      expect(login.status).toBe(302)
      if (kind === 'microsoft')
        expect(idp.authorization.pathname).toBe('/common/oauth2/v2.0/authorize')
      const response = await idp.finish(login)
      expect(idp.onError.mock.calls).toEqual([])
      expect(response.status, await response.clone().text()).toBe(200)
      const profile = await response.json()
      expect(profile.subject).toBe('external-user')
      if (kind === 'apple') expect(profile.emailVerified).toBe(true)
      expect(profile.name).toBe(kind === 'apple' ? 'Apple User' : 'Protocol User')
      expect(idp.exchangedRedirect).toBe(idp.redirectUri)
      expect(idp.exchanges).toBe(1)
      expect(idp.discoveries).toBe(1)
      expect(response.headers.getSetCookie()[0]).toContain('Path=/account/callback')
      expect(response.headers.getSetCookie()[0]).toContain('Max-Age=0')
      expect('auth' in idp.app).toBe(false)
    },
  )

  it.each(['wrongNonce', 'wrongSubject', 'missingIdToken'] as const)(
    'rejects %s through the upstream protocol checks',
    async (failure) => {
      const idp = await createIdp({ [failure]: true })
      expect((await idp.finish(await idp.begin())).status).toBe(401)
      expect(idp.onSuccess).not.toHaveBeenCalled()
      expect(idp.onError).toHaveBeenCalledOnce()
    },
  )

  it.each([403, 500])(
    'preserves HTTP %s for application success-callback failures',
    async (status) => {
      const idp = await createIdp()
      idp.onSuccess.mockImplementation(() => {
        if (status === 403)
          throw new HTTPException(403, { message: 'Account policy rejected access' })
        throw new Error('Account store unavailable')
      })
      const response = await idp.finish(await idp.begin())
      expect(response.status).toBe(status)
      expect(idp.onError).not.toHaveBeenCalled()
      expect(response.headers.getSetCookie()[0]).toContain('Max-Age=0')
    },
  )

  it('propagates application onError exceptions without invoking it a second time', async () => {
    const idp = await createIdp({ wrongNonce: true })
    idp.onError.mockImplementation(() => {
      throw new HTTPException(503, { message: 'Application error handling unavailable' })
    })
    const response = await idp.finish(await idp.begin())
    expect(response.status).toBe(503)
    expect(idp.onError).toHaveBeenCalledOnce()
  })

  it.each(['success', 'error'] as const)(
    'returns 204 for an application %s callback returning void',
    async (callback) => {
      const idp = await createIdp({ wrongNonce: callback === 'error' })
      if (callback === 'success') idp.onSuccess.mockReturnValue(undefined)
      else idp.onError.mockReturnValue(undefined)
      const response = await idp.finish(await idp.begin())
      expect(response.status).toBe(204)
      expect(await response.text()).toBe('')
    },
  )

  it('keeps the Apple form available to the application success callback', async () => {
    const idp = await createIdp({ kind: 'apple' })
    idp.onSuccess.mockImplementation(async (profile, _tokens, ctx) => {
      const body = await ctx.req.parseBody()
      return Response.json({ subject: profile.subject, code: body.code })
    })
    const response = await idp.finish(await idp.begin())
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ subject: 'external-user', code: 'single-use-code' })
  })

  it('uses Apple ID Token claims when later authorizations omit the one-time user form', async () => {
    const idp = await createIdp({ kind: 'apple', omitAppleUser: true })
    const response = await idp.finish(await idp.begin())
    expect(response.status).toBe(200)
    const profile = await response.json()
    expect(profile).toMatchObject({
      subject: 'external-user',
      email: 'reader@example.com',
      emailVerified: true,
    })
    expect(profile.name).toBeUndefined()
  })

  it('trims Apple user names and falls back to claims when whitespace-only', async () => {
    const idp = await createIdp({
      kind: 'apple',
      claims: { name: 'Claimed Name' },
      appleUser: {
        name: { firstName: '   ', lastName: '   ' },
        email: 'reader@example.com',
      },
    })
    const response = await idp.finish(await idp.begin())
    expect(response.status).toBe(200)
    const profile = await response.json()
    expect(profile.name).toBe('Claimed Name')
  })

  it('cancels discovery with the initiating request without retaining its signal', async () => {
    const idp = await createIdp()
    const controller = new AbortController()
    controller.abort(new Error('client disconnected'))
    const response = await idp.app.fetch(
      new Request('https://local.test/signin', { signal: controller.signal }),
    )
    expect(response.status).toBe(401)
    expect(idp.discoveries).toBe(0)
    expect((await idp.begin()).status).toBe(302)
    expect(idp.discoveries).toBe(1)
  })

  it('retries discovery after a transient failure instead of retaining a rejected promise', async () => {
    const idp = await createIdp({ failDiscovery: true })
    expect((await idp.begin()).status).toBe(401)
    expect((await idp.begin()).status).toBe(302)
    expect(idp.discoveries).toBe(2)
  })
})
