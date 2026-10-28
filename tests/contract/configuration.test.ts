import { afterEach, expect, it, vi } from 'vitest'

import { type ClientOptions, createClient } from '../../src/entries/http'
import { createDefinition } from '../../src/entries/runtime/core'
import { createApp, defineApp, route, setCookie } from '../../src/entries/server'
import { parseApiFilePath } from '../../src/http/path'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

it('uses environment defaults captured at creation throughout requests', async () => {
  const definition = createDefinition({
    app: defineApp({ cookie: { sameSite: undefined } }),
    routes: [
      {
        routePath: parseApiFilePath('cookie.get.ts', '/api')!,
        declaration: route().handler((ctx) => {
          setCookie(ctx, 'theme', 'dark')
          return { ok: true }
        }),
      },
      {
        routePath: parseApiFilePath('error.get.ts', '/api')!,
        declaration: route().handler(() => {
          throw new Error('development detail')
        }),
      },
    ],
  })
  vi.stubEnv('NODE_ENV', 'development')
  const development = await createApp(definition)
  vi.stubEnv('NODE_ENV', 'production')
  const production = await createApp(definition)
  vi.stubEnv('NODE_ENV', 'development')
  vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    for (const [app, secure, message] of [
      [development, false, 'development detail'],
      [production, true, 'Internal Server Error'],
    ] as const) {
      const response = await app.fetch(new Request('https://example.test/api/cookie'))
      const cookie = response.headers.get('set-cookie')!
      expect(cookie).toContain('SameSite=Lax')
      expect(cookie.includes('Secure')).toBe(secure)
      const error = await app.fetch(new Request('https://example.test/api/error'))
      expect(error.status).toBe(500)
      expect((await error.json()).error.message).toBe(message)
    }
  } finally {
    await Promise.all([development.close(), production.close()])
  }
})

it('uses resolved client options for typed and raw calls while factories remain dynamic', async () => {
  const requests: Request[] = []
  const headers = new Headers({ 'X-Instance': 'original' })
  const options: ClientOptions = {
    baseUrl: 'https://example.test/service',
    credentials: 'include',
    headers,
    fetch: async (request) => {
      requests.push(request)
      return new Response(null, { status: 204 })
    },
  }
  const client = createClient(options)
  options.baseUrl = 'https://wrong.test'
  options.credentials = 'omit'
  headers.set('X-Instance', 'changed')
  await client.get('/item')
  await client.requestRaw('POST', '/item', {
    credentials: 'omit',
    headers: { 'X-Instance': 'call' },
  })
  await client.get('/item', { init: { credentials: 'same-origin' } })
  expect(requests.map((request) => request.url)).toEqual(
    Array(3).fill('https://example.test/service/item'),
  )
  expect(requests.map((request) => request.credentials)).toEqual(['include', 'omit', 'same-origin'])
  expect(requests.map((request) => request.headers.get('X-Instance'))).toEqual([
    'original',
    'call',
    'original',
  ])

  let token = 'first'
  const factory = vi.fn(() => ({ Authorization: `Bearer ${token}` }))
  const dynamic = createClient({ ...options, headers: factory })
  expect(factory).not.toHaveBeenCalled()
  await dynamic.get('/item')
  token = 'second'
  await dynamic.requestRaw('GET', '/item')
  expect(requests.slice(-2).map((request) => request.headers.get('Authorization'))).toEqual([
    'Bearer first',
    'Bearer second',
  ])
  expect(factory).toHaveBeenCalledTimes(2)
})
