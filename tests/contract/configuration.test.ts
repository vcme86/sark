import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { createServer } from 'vite'
import { afterEach, expect, it, vi } from 'vitest'

import { type ClientOptions, createClient } from '../../src/entries/http'
import { createDefinition } from '../../src/entries/runtime/core'
import { createApp, defineApp, route, setCookie } from '../../src/entries/server'
import { sark } from '../../src/tooling/vite'
import { parseApiFilePath } from '../../src/web/http/path'

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

it.each(['/service/v2/', '/'])(
  'runs generated routes with custom project paths and prefix %s',
  async (apiPrefix) => {
    mkdirSync('.build', { recursive: true })
    const root = mkdtempSync(resolve('.build/configuration-'))
    mkdirSync(resolve(root, 'config'))
    mkdirSync(resolve(root, 'handlers'))
    writeFileSync(
      resolve(root, 'config/application.ts'),
      `import { defineApp } from '@olivaw/sark/server'
export const app = defineApp({ headers: { 'X-Project': 'custom' } })`,
    )
    writeFileSync(
      resolve(root, 'handlers/item.get.ts'),
      `import { route } from '@olivaw/sark/server'
export default route().handler(() => ({ item: 42 }))`,
    )
    const server = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      server: { middlewareMode: true, hmr: false, watch: null },
      plugins: [
        sark({
          appEntry: 'config/application.ts',
          apiDir: 'handlers',
          generatedDir: 'generated/server',
          apiPrefix,
        }),
      ],
    })
    let instance: Awaited<ReturnType<typeof createApp>> | undefined
    try {
      const { definition } = await server.ssrLoadModule('/generated/server/app.ts')
      const { createApp: createBuiltApp } = await import('@olivaw/sark/server')
      instance = await createBuiltApp(definition, { env: process.env })
      const prefix = apiPrefix === '/' ? '' : '/service/v2'
      const response = await instance.fetch(new Request(`https://example.test${prefix}/item`))
      expect(response.status).toBe(200)
      expect(response.headers.get('X-Project')).toBe('custom')
      expect(await response.json()).toEqual({ item: 42 })
      expect((await instance.fetch(new Request('https://example.test/api/item'))).status).toBe(404)
    } finally {
      await instance?.close()
      await server.close()
      rmSync(root, { recursive: true, force: true })
    }
  },
)
