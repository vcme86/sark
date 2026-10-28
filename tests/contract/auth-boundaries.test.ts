import { configureSync, type LogRecord, resetSync } from '@logtape/logtape'
import { expect, it, vi } from 'vitest'

import { createWorkerHandler } from '../../src/adapter/cloudflare/runtime'
import { getCurrentScope } from '../../src/core/context'
import { createApp } from '../../src/core/create'
import { createDefinition } from '../../src/core/definition'
import { ensureBasicLogging, getLogger } from '../../src/core/logging'
import { defineOAuth } from '../../src/entries/auth/oauth'
import { defineAuth, type RequestAuth, signToken } from '../../src/entries/auth/session'
import { defineApp, route } from '../../src/entries/server'
import { parseApiFilePath } from '../../src/http/path'
import { createOAuthAssembly } from '../../src/services/auth/oauth/assembly'
import { createAuthAssembly } from '../../src/services/auth/session/assembly'

const secret = 'session-signing-secret-at-least-32-bytes'

it('records authentication hook failures through default diagnostics', async () => {
  resetSync()
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  const instance = await createApp(
    createDefinition({
      app: defineApp({ cors: { origin: 'https://frontend.test' } }),
      services: {
        auth: createAuthAssembly(
          defineAuth({
            secret,
            validate: async () => {
              throw new Error('database unavailable')
            },
          }),
        ),
      },
      routes: [
        {
          routePath: parseApiFilePath('me.get.ts', '/api')!,
          declaration: route().handler((ctx) => ({
            user: (ctx.get('auth' as never) as RequestAuth).identity,
          })),
        },
      ],
    }),
  )
  try {
    const token = await signToken({ sub: 'reader' }, { secret })
    const response = await instance.fetch(
      new Request('http://localhost/api/me', {
        headers: { Authorization: `Bearer ${token}`, Origin: 'https://frontend.test' },
      }),
    )
    expect(response.status).toBe(500)
    expect((await response.json()).error.code).toBe('internal_server_error')
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://frontend.test')
    expect(consoleError).toHaveBeenCalledOnce()
    expect(consoleError.mock.calls.flat().join(' ')).toContain('database unavailable')
  } finally {
    await instance.close()
    consoleError.mockRestore()
    resetSync()
  }
})

it('preserves host logging and attaches the active request ID to hook failures', async () => {
  resetSync()
  const records: LogRecord[] = []
  configureSync({
    sinks: {
      host: (record) => {
        records.push(record)
      },
    },
    loggers: [{ category: ['app'], lowestLevel: 'info', sinks: ['host'] }],
  })
  const instance = await createApp(
    createDefinition({
      services: {
        auth: createAuthAssembly(
          defineAuth({
            secret,
            tokenVersion: async () => {
              throw new Error('version store unavailable')
            },
          }),
        ),
      },
      routes: [
        {
          routePath: parseApiFilePath('me.get.ts', '/api')!,
          declaration: route().handler(() => null),
        },
      ],
    }),
  )
  try {
    const token = await signToken({ sub: 'reader' }, { secret })
    const response = await instance.fetch(
      new Request('http://localhost/api/me', { headers: { Authorization: `Bearer ${token}` } }),
    )
    expect(records).toHaveLength(1)
    expect(response.status).toBe(500)
    expect(records[0].category).toEqual(['app'])
    expect(records[0].properties.requestId).toBe(response.headers.get('X-Request-Id'))
  } finally {
    await instance.close()
    resetSync()
    ensureBasicLogging()
  }
})

it('skips account checks for preflight and URL redirects, then authenticates the canonical request', async () => {
  const tokenVersion = vi.fn(async () => 0)
  const instance = await createApp(
    createDefinition({
      app: defineApp({ cors: { origin: 'https://frontend.test' } }),
      services: { auth: createAuthAssembly(defineAuth({ secret, tokenVersion })) },
      routes: [
        {
          routePath: parseApiFilePath('me.get.ts', '/api')!,
          declaration: route().handler((ctx) => ({
            sub: (ctx.get('auth' as never) as RequestAuth).identity?.sub,
          })),
        },
      ],
    }),
  )
  try {
    const token = await signToken({ sub: 'reader' }, { secret })
    const preflight = await instance.fetch(
      new Request('http://localhost/api/me', {
        method: 'OPTIONS',
        headers: { Origin: 'https://frontend.test', 'Access-Control-Request-Method': 'GET' },
      }),
    )
    expect(preflight.status).toBe(204)
    expect(tokenVersion).not.toHaveBeenCalled()

    const headers = { Cookie: `auth_token=${token}`, Origin: 'https://frontend.test' }
    const redirect = await instance.fetch(new Request('http://localhost/api/me/', { headers }))
    expect(redirect.status).toBe(308)
    expect(redirect.headers.get('Access-Control-Allow-Origin')).toBe('https://frontend.test')
    expect(tokenVersion).not.toHaveBeenCalled()

    const response = await instance.fetch(new Request('http://localhost/api/me', { headers }))
    expect(await response.json()).toEqual({ sub: 'reader' })
    expect(tokenVersion).toHaveBeenCalledOnce()
  } finally {
    await instance.close()
  }
})

it.each(['node', 'cloudflare'] as const)(
  'rejects normalized OAuth route conflicts before creating %s resources',
  async (target) => {
    const createResource = vi.fn(() => ({ value: {} }))
    const definition = createDefinition({
      app: defineApp({ cookie: { secret: 'oauth-cookie-secret-long-enough' } }),
      routes: [
        {
          routePath: parseApiFilePath('account.signin.get.ts', '/')!,
          declaration: route().handler(() => null),
        },
      ],
      resources: {
        db:
          target === 'node'
            ? { target, createStatic: async () => createResource() }
            : { target, createForEvent: createResource },
      },
      services: {
        oauth: createOAuthAssembly(
          defineOAuth([
            {
              id: 'github',
              kind: 'github',
              clientId: 'client',
              clientSecret: 'secret',
              scopes: [],
              signInPath: '/ACCOUNT/signin',
              redirectUri: 'https://public.test/callback',
              onSuccess() {},
            },
          ]),
          '/api',
        ),
      },
    })
    if (target === 'node') await expect(createApp(definition)).rejects.toThrow(/Route conflict/)
    else {
      const response = await createWorkerHandler(definition).fetch(
        new Request('https://public.test/account/signin'),
        {},
        { waitUntil() {}, passThroughOnException() {} },
      )
      expect(response.status).toBe(500)
    }
    expect(createResource).not.toHaveBeenCalled()
  },
)

it('exposes only verification and keeps hook caches independent across instances of one definition', async () => {
  const validate = vi.fn(async () => true)
  const definition = createDefinition({
    services: {
      auth: createAuthAssembly(
        defineAuth({
          secret,
          validate,
          cacheTtl: 60,
          cacheKey: (identity) => identity.sub,
        }),
      ),
    },
  })
  const first = await createApp(definition)
  const second = await createApp(definition)
  try {
    expect(Object.keys(first.auth).toSorted()).toEqual(['authenticate', 'verify'])
    const token = await signToken({ sub: 'reader' }, { secret })
    const { verify } = first.auth
    expect((await verify(token))?.sub).toBe('reader')
    expect((await first.auth.verify(token))?.sub).toBe('reader')
    expect((await second.auth.verify(token))?.sub).toBe('reader')
    expect(validate).toHaveBeenCalledTimes(2)
  } finally {
    await Promise.all([first.close(), second.close()])
  }
})

it('awaits request authentication in the active scope before running business handlers', async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let validationScope: ReturnType<typeof getCurrentScope>
  const business = vi.fn((ctx) => ({ sub: ctx.var.auth.identity?.sub }))
  const instance = await createApp(
    createDefinition({
      app: defineApp({ headers: { 'X-Owner': 'request' } }),
      services: {
        auth: createAuthAssembly(
          defineAuth({
            secret,
            async validate() {
              validationScope = getCurrentScope()
              entered.resolve()
              await release.promise
              return true
            },
          }),
        ),
      },
      routes: [
        {
          routePath: parseApiFilePath('who.get.ts', '/api')!,
          declaration: route().handler(business),
        },
      ],
    }),
  )
  const token = await signToken({ sub: 'reader' }, { secret })
  const request = new Request('https://local.test/api/who', {
    headers: { Authorization: `Bearer ${token}` },
  })
  const pending = instance.fetch(request)
  try {
    await entered.promise
    expect(business).not.toHaveBeenCalled()
    expect(validationScope?.request).toBe(request)
    expect(validationScope?.app).toBe(instance)
    expect(validationScope?.config).toBe(instance.config)
    release.resolve()
    const response = await pending
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ sub: 'reader' })
    expect(response.headers.get('X-Request-Id')).toBe(validationScope?.requestId)
  } finally {
    release.resolve()
    await pending
    await instance.close()
  }
})

it('disables default headers without deleting application headers and preserves the request ID', async () => {
  const instance = await createApp(
    createDefinition({
      app: defineApp({ headers: { 'x-frame-options': false } }),
      routes: [
        {
          routePath: parseApiFilePath('headers.get.ts', '/api')!,
          declaration: route().handler(
            () =>
              new Response('body', {
                headers: { 'X-Frame-Options': 'DENY', 'X-Request-Id': 'application-value' },
              }),
          ),
        },
      ],
    }),
  )
  try {
    const response = await instance.fetch(new Request('http://localhost/api/headers'))
    expect(response.headers.get('X-Frame-Options')).toBe('DENY')
    expect(response.headers.get('X-Request-Id')).not.toBe('application-value')
    expect(await response.text()).toBe('body')
  } finally {
    await instance.close()
  }
})

it('reuses event configuration and domain routes during concurrent internal Workers dispatch', async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let entries = 0
  const factory = vi.fn((env: { ID: string; CLIENT: string }) => [
    {
      id: env.ID,
      kind: 'github' as const,
      clientSecret: 'test-client-secret',
      clientId: env.CLIENT,
      scopes: [],
      signInPath: '/signin',
      callbackPath: '/callback',
      redirectUri: 'https://public.test/callback',
      onSuccess() {},
    },
  ])
  const handler = createWorkerHandler(
    createDefinition({
      app: defineApp({ cookie: { secret } }),
      services: { oauth: createOAuthAssembly(defineOAuth(factory), '/api') },
      routes: [
        {
          routePath: parseApiFilePath('parent.get.ts', '/api')!,
          declaration: route().handler(async () => {
            const scope = getCurrentScope()!
            if (++entries === 2) entered.resolve()
            await release.promise
            const response = await scope.app!.fetchInternal(
              new Request('https://local.test/signin'),
            )
            return {
              client: new URL(response.headers.get('Location')!).searchParams.get('client_id'),
              status: response.status,
            }
          }),
        },
      ],
    }),
  )
  const execution = { waitUntil: vi.fn(), passThroughOnException: vi.fn() }
  const first = handler.fetch(
    new Request('https://local.test/api/parent'),
    { ID: 'first', CLIENT: 'one' },
    execution,
  )
  const second = handler.fetch(
    new Request('https://local.test/api/parent'),
    { ID: 'second', CLIENT: 'two' },
    execution,
  )
  await entered.promise.finally(() => release.resolve())
  const responses = await Promise.all([first, second])
  expect(await responses[0].json()).toEqual({ client: 'one', status: 302 })
  expect(await responses[1].json()).toEqual({ client: 'two', status: 302 })
  expect(responses[0].headers.getSetCookie()[0]).toMatch(/^__sark_oauth_first=/)
  expect(responses[1].headers.getSetCookie()[0]).toMatch(/^__sark_oauth_second=/)
  expect(factory).toHaveBeenCalledTimes(2)
})

it('attaches request IDs as structured fields when a logger is created before requests', async () => {
  resetSync()
  const records: LogRecord[] = []
  configureSync({
    sinks: { host: (record) => records.push(record) },
    loggers: [{ category: ['app'], lowestLevel: 'info', sinks: ['host'] }],
  })
  const logger = getLogger('business')
  const instance = await createApp(
    createDefinition({
      routes: [
        {
          routePath: parseApiFilePath('log.get.ts', '/api')!,
          declaration: route().handler(() => {
            logger.info('Loaded')
            logger.warn('Details', { item: 42 })
            return null
          }),
        },
      ],
    }),
  )
  try {
    for (let index = 0; index < 2; index++) {
      const response = await instance.fetch(new Request('http://localhost/api/log'))
      const [info, warning] = records.slice(index * 2)
      expect(info.properties.requestId).toBe(response.headers.get('X-Request-Id'))
      expect(warning.properties.requestId).toBe(response.headers.get('X-Request-Id'))
      expect(info.properties).not.toHaveProperty('args')
      expect(warning.properties.args).toEqual([{ item: 42 }])
      expect(info.message.join('')).not.toContain('[req:')
    }
    expect(records[0].properties.requestId).not.toBe(records[2].properties.requestId)
  } finally {
    await instance.close()
    resetSync()
  }
})
