import type { Context } from 'hono'
import { expect, it } from 'vitest'

import { createDefinition } from '../../src/entries/runtime/core'
import {
  type AppConfig,
  type AppInstance,
  createApp,
  defineApp,
  HttpError,
  route,
  type RouteDeclaration,
  z,
} from '../../src/entries/server'
import { parseApiFilePath } from '../../src/web/http/path'
import type { RouteEntry } from '../../src/web/http/server/pipeline'

const origin = 'https://frontend.example'
const entry = (file: string, declaration: RouteDeclaration): RouteEntry => ({
  routePath: parseApiFilePath(file, '/api')!,
  declaration,
})
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

it('keeps CORS on an authorization rejection', async () => {
  await withApp(
    { cors: { origin, credentials: true }, middleware: [async (ctx) => ctx.text('Denied', 403)] },
    [
      entry(
        'private.get.ts',
        route().handler(() => 'private'),
      ),
    ],
    async (app) => {
      const response = await app.fetch(
        new Request('https://api.example/api/private', { headers: { Origin: origin } }),
      )
      expect(response.status).toBe(403)
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin)
    },
  )
})

it('keeps CORS on body-limit rejection before application middleware', async () => {
  let ran = false
  await withApp(
    {
      cors: { origin },
      bodyLimit: 1,
      csrf: { origins: [origin] },
      middleware: [
        async (_ctx, next) => {
          ran = true
          await next()
        },
      ],
    },
    [
      entry(
        'write.post.ts',
        route()
          .validate({ json: z.object({ name: z.string() }) })
          .handler((_ctx, input) => input.json),
      ),
    ],
    async (app) => {
      const response = await app.fetch(
        new Request('https://api.example/api/write', {
          method: 'POST',
          headers: { Origin: origin, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Alice' }),
        }),
      )
      expect(response.status).toBe(413)
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin)
      expect(ran).toBe(false)
    },
  )
})

it('keeps CORS on an independent CSRF rejection', async () => {
  await withApp(
    { cors: { origin } },
    [
      entry(
        'write.post.ts',
        route().handler(() => 'updated'),
      ),
    ],
    async (app) => {
      const response = await app.fetch(
        new Request('https://api.example/api/write', {
          method: 'POST',
          headers: { Origin: origin, 'Content-Type': 'text/plain' },
          body: 'update',
        }),
      )
      expect(response.status).toBe(403)
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin)
      expect((await response.json()).error.code).toBe('csrf_forbidden')
    },
  )
})

it('preserves business 403 error code without rewriting to csrf_forbidden', async () => {
  await withApp(
    { csrf: true },
    [
      entry(
        'secure.post.ts',
        route().handler(() => {
          throw new HttpError(403, 'Permission denied', { code: 'custom_forbidden' })
        }),
      ),
    ],
    async (app) => {
      // Valid JSON POST passes CSRF check; downstream business handler throws 403
      const response = await app.fetch(
        new Request('https://api.example/api/secure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'delete' }),
        }),
      )
      expect(response.status).toBe(403)
      const data = await response.json()
      expect(data.error.code).toBe('custom_forbidden')
      expect(data.error.message).toBe('Permission denied')
    },
  )
})

it.each([
  { trailingSlash: 'never', suffix: '/', status: 308, location: 'https://api.example/api/item' },
  { trailingSlash: 'always', suffix: '', status: 308, location: 'https://api.example/api/item/' },
  { trailingSlash: 'always', suffix: '/', status: 200, location: null },
  { trailingSlash: 'ignore', suffix: '/', status: 200, location: null },
] as const)(
  'keeps route CORS for $trailingSlash with suffix "$suffix"',
  async ({ trailingSlash, suffix, status, location }) => {
    await withApp(
      { cors: false, trailingSlash },
      [
        entry(
          'item.get.ts',
          route({ cors: { origin } }).handler(() => 'item'),
        ),
      ],
      async (app) => {
        const response = await app.fetch(
          new Request(`https://api.example/api/item${suffix}`, { headers: { Origin: origin } }),
        )
        expect(response.status).toBe(status)
        expect(response.headers.get('Location')).toBe(location)
        expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin)
      },
    )
  },
)

it('selects method-specific preflight CORS while preserving route parameters on a shared path', async () => {
  const methods = ['get', 'post', 'put', 'delete']
  const routes = methods.map((method) =>
    entry(
      `users.[id].${method}.ts`,
      route({
        cors: {
          origin: (incoming, ctx) =>
            ctx.req.param('id') === 'Alice' && incoming === `https://${method}.example`
              ? incoming
              : '',
        },
      }).handler(() => method),
    ),
  )
  await withApp({}, routes, async (app) => {
    for (const method of methods) {
      const incoming = `https://${method}.example`
      const response = await app.fetch(
        new Request('https://api.example/api/users/Alice', {
          method: 'OPTIONS',
          headers: { Origin: incoming, 'Access-Control-Request-Method': method.toUpperCase() },
        }),
      )
      expect(response.status).toBe(204)
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe(incoming)
    }
  })
})

it('preserves route parameters in CORS origin callbacks and preflight', async () => {
  const cors = {
    origin: (incoming: string, ctx: Context) => (ctx.req.param('id') === 'Alice' ? incoming : ''),
  }
  await withApp(
    { cors },
    [
      entry(
        'users.[id].get.ts',
        route().handler((ctx) => ctx.req.param('id')),
      ),
    ],
    async (app) => {
      for (const method of ['GET', 'OPTIONS']) {
        const response = await app.fetch(
          new Request('https://api.example/api/users/Alice', {
            method,
            headers: {
              Origin: origin,
              ...(method === 'OPTIONS' ? { 'Access-Control-Request-Method': 'GET' } : {}),
            },
          }),
        )
        expect(response.status).toBe(method === 'OPTIONS' ? 204 : 200)
        expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin)
      }
    },
  )
})

it('keeps specific-method CORS disabled while ALL handles other methods', async () => {
  await withApp(
    { cors: { origin } },
    [
      entry(
        'item.all.ts',
        route({ cors: { origin: 'https://fallback.example' } }).handler(() => 'fallback'),
      ),
      entry(
        'item.get.ts',
        route({ cors: false }).handler(() => 'specific'),
      ),
    ],
    async (app) => {
      const get = await app.fetch(
        new Request('https://api.example/api/item', { headers: { Origin: origin } }),
      )
      expect(await get.json()).toBe('specific')
      expect(get.headers.get('Access-Control-Allow-Origin')).toBeNull()
      for (const target of ['GET', 'POST']) {
        const response = await app.fetch(
          new Request('https://api.example/api/item', {
            method: 'OPTIONS',
            headers: {
              Origin: 'https://fallback.example',
              'Access-Control-Request-Method': target,
            },
          }),
        )
        expect(response.headers.get('Access-Control-Allow-Origin')).toBe(
          target === 'GET' ? null : 'https://fallback.example',
        )
      }
    },
  )
})

it('does not stack a generic route body limit onto a more specific relaxed route', async () => {
  const handler = route({ bodyLimit: 64, cors: { origin } })
    .validate({ json: z.object({ name: z.string() }) })
    .handler((_ctx, input) => input.json)
  await withApp(
    { bodyLimit: 1, csrf: false },
    [
      entry(
        'items.[id].post.ts',
        route({ bodyLimit: 1 }).handler(() => 'generic'),
      ),
      entry('items.new.post.ts', handler),
    ],
    async (app) => {
      const response = await app.fetch(
        new Request('https://api.example/api/items/new', {
          method: 'POST',
          headers: { Origin: origin, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'Alice' }),
        }),
      )
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ name: 'Alice' })
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin)
    },
  )
})

it('retains global middleware and application CORS on unmatched requests', async () => {
  let calls = 0
  await withApp(
    {
      cors: { origin },
      middleware: [
        async (_ctx, next) => {
          calls++
          await next()
        },
      ],
    },
    [],
    async (app) => {
      const response = await app.fetch(
        new Request('https://api.example/missing', { headers: { Origin: origin } }),
      )
      expect(response.status).toBe(404)
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin)
      expect(calls).toBe(1)
    },
  )
})

it('lets a more specific ALL route take precedence over a generic GET route', async () => {
  await withApp(
    {},
    [
      entry(
        'items.[id].get.ts',
        route({ cors: { origin: 'https://generic.example' } }).handler(() => 'generic'),
      ),
      entry(
        'items.new.all.ts',
        route({ cors: { origin } }).handler(() => 'static'),
      ),
    ],
    async (app) => {
      const response = await app.fetch(
        new Request('https://api.example/api/items/new', { headers: { Origin: origin } }),
      )
      expect(await response.json()).toBe('static')
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin)
      const preflight = await app.fetch(
        new Request('https://api.example/api/items/new', {
          method: 'OPTIONS',
          headers: { Origin: origin, 'Access-Control-Request-Method': 'GET' },
        }),
      )
      expect(preflight.status).toBe(204)
      expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe(origin)
    },
  )
})
