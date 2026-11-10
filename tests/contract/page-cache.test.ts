import { createElement, Suspense, use } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getCurrentScope } from '../../src/app/context'
import { createDefinition } from '../../src/app/definition'
import { applicationLifecycles } from '../../src/app/lifecycle'
import {
  definePageCache,
  type PageCacheOptions,
  revalidatePath,
  revalidateTag,
} from '../../src/entries/page-cache'
import { type AppConfig, type AppInstance, createApp, defineApp } from '../../src/entries/root'
import { parseApiFilePath } from '../../src/http/path'
import { createPageConfigResolver } from '../../src/page/config'
import { createPageCacheAssembly } from '../../src/page/server/assembly'
import { createPageHandler } from '../../src/page/server/handler'
import type { ServerPageScope } from '../../src/page/types'

const instances: AppInstance[] = []
const releases: (() => void)[] = []

function barrier<T = void>() {
  const gate = Promise.withResolvers<T>()
  releases.push(() => gate.resolve(undefined as T))
  return gate
}

async function fixture(
  page: Partial<Omit<ServerPageScope, 'id'>>,
  options: {
    cache?: PageCacheOptions
    app?: AppConfig
    layouts?: ServerPageScope[]
    enabled?: boolean
  } = {},
) {
  const definition = createDefinition({
    app: defineApp(options.app ?? {}),
    apiPrefix: '/api',
    webPrefix: '/',
    createPageConfigResolver: () => createPageConfigResolver(undefined, '/api'),
    services:
      options.enabled === false
        ? undefined
        : { cache: createPageCacheAssembly(definePageCache(options.cache)) },
    routes: [
      {
        routePath: parseApiFilePath('index.get.ts', '/')!,
        pageHandler: createPageHandler(
          {
            pattern: '/',
            shapeKey: '/',
            paramNames: [],
            httpScopes: [],
            scopes: [
              ...(options.layouts ?? []),
              { id: 'page', component: () => null, cache: { ttl: 60 }, ...page },
            ],
          },
          () => ({ bootstrapModules: [], stylesheets: [], routeStyles: {} }),
        ),
      },
    ],
  })
  const app = await createApp(definition)
  instances.push(app)
  const read = async (headers?: HeadersInit, query = '', origin = 'http://localhost') => {
    const response = await app.fetch(new Request(origin + '/' + query, { headers }))
    return { response, text: await response.text() }
  }
  const idle = () => applicationLifecycles.get(app)!.waitForIdle()
  return { app, read, idle }
}

beforeEach(() => vi.stubEnv('NODE_ENV', 'production'))
afterEach(async () => {
  for (const release of releases.splice(0)) release()
  await Promise.all(instances.splice(0).map((app) => app.close()))
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('public page cache', () => {
  it('honors application middleware opting out before a previously cached page is selected', async () => {
    let bypass = false
    let renders = 0
    const { read, idle } = await fixture(
      { loader: () => ({ version: ++renders }) },
      {
        app: {
          middleware: [
            async (ctx, next) => {
              if (bypass) ctx.header('Cache-Control', 'private, no-store')
              await next()
            },
          ],
        },
      },
    )
    await read()
    await idle()
    bypass = true
    const response = await read()
    expect(response.text).toContain('"version":2')
    expect(response.response.headers.get('cache-control')).toBe('private, no-store')
    expect(renders).toBe(2)
  })

  it('does not create a cache service when storage is omitted', async () => {
    const { app, read } = await fixture({}, { enabled: false })
    expect('cache' in app).toBe(false)
    expect((await read()).response.status).toBe(200)
    expect(() => revalidatePath('/')).toThrow('active application context')
    expect(() => revalidateTag('articles')).toThrow('active application context')
  })

  it('reuses a complete representation with ETag, Age and HEAD delivery', async () => {
    let renders = 0
    const { app, read, idle } = await fixture({ loader: () => ({ version: ++renders }) })
    const first = await read()
    await idle()
    const second = await read()
    expect(second.text).toBe(first.text)
    expect(renders).toBe(1)
    expect(second.response.headers.get('etag')).toMatch(/^W\//)
    expect(second.response.headers.get('age')).toBe('0')
    const conditional = await read({ 'if-none-match': second.response.headers.get('etag')! })
    expect(conditional.response.status).toBe(304)
    expect(conditional.text).toBe('')
    const head = await app.fetch(new Request('http://localhost/', { method: 'HEAD' }))
    expect(head.headers.get('etag')).toBe(second.response.headers.get('etag'))
    expect(await head.text()).toBe('')
    expect(renders).toBe(1)
  })

  it('partitions by public origin, complete query, and declared header values', async () => {
    let renders = 0
    const { read, idle } = await fixture({
      cache: { ttl: 60, vary: ['x-a', 'x-b'] },
      loader: () => ({ version: ++renders }),
    })
    const a = { 'x-a': 'alpha|x-b:beta', 'x-b': 'gamma' }
    const b = { 'x-a': 'alpha', 'x-b': 'beta|x-b:gamma' }
    await read(a)
    await idle()
    await read(b)
    await idle()
    await read(a, '?a=1&b=2')
    await idle()
    await read(a, '?b=2&a=1')
    await idle()
    await read(a, '', 'http://other.localhost')
    await idle()
    await read(a)
    expect(renders).toBe(5)
  })

  it.each<HeadersInit>([
    { cookie: 'visitor_id=guest' },
    { authorization: 'Bearer token' },
    { 'cache-control': 'no-store' },
  ])('bypasses storage for credentials or no-store: %j', async (headers) => {
    let renders = 0
    const { read } = await fixture({ loader: () => ({ version: ++renders }) })
    await read(headers)
    await read(headers)
    expect(renders).toBe(2)
  })

  it('uses defaultTtl in both public headers and storage', async () => {
    let renders = 0
    const { read, idle } = await fixture(
      { cache: {}, loader: () => ++renders },
      { cache: { defaultTtl: 60 } },
    )
    expect((await read()).response.headers.get('cache-control')).toContain('s-maxage=60')
    await idle()
    await read()
    expect(renders).toBe(1)
  })

  it('resets inherited policy with cache=false', async () => {
    let renders = 0
    const { read } = await fixture(
      { cache: false, loader: () => ++renders },
      {
        layouts: [{ id: 'layout', component: () => null, cache: { ttl: 60 } }],
      },
    )
    expect((await read()).response.headers.get('cache-control')).toBe('no-store')
    await read()
    expect(renders).toBe(2)
  })

  it.each(['private, no-store', 'no-cache'])(
    'honors final middleware Cache-Control: %s',
    async (policy) => {
      let renders = 0
      const { read } = await fixture(
        { loader: () => ++renders },
        {
          app: {
            middleware: [
              async (ctx, next) => {
                await next()
                ctx.header('Cache-Control', policy)
              },
            ],
          },
        },
      )
      await read()
      await read()
      expect(renders).toBe(2)
    },
  )

  it.each(['X-Locale', '*', 'Origin'])(
    'rejects undeclared final application Vary: %s',
    async (vary) => {
      let renders = 0
      const { read } = await fixture(
        { loader: () => ++renders },
        {
          app: {
            cors: { origin: (origin) => origin },
            middleware: [
              async (ctx, next) => {
                await next()
                ctx.header('Vary', vary)
              },
            ],
          },
        },
      )
      await read({ Origin: 'https://a.example' })
      await read({ Origin: 'https://b.example' })
      expect(renders).toBe(2)
    },
  )

  it('reconstructs CORS while retaining application Origin variants', async () => {
    const options = { app: { cors: { origin: (origin: string) => origin } } }
    let renders = 0
    const { read, idle } = await fixture({ loader: () => ++renders }, options)
    await read({ Origin: 'https://a.example' })
    await idle()
    const second = await read({ Origin: 'https://b.example' })
    expect(second.response.headers.get('access-control-allow-origin')).toBe('https://b.example')
    expect(second.response.headers.get('vary')).toContain('Origin')
    expect(renders).toBe(1)

    const variant = await fixture(
      {
        cache: { ttl: 60, vary: ['Origin'] },
        loader: () => ({ origin: getCurrentScope()!.request!.headers.get('origin') }),
      },
      options,
    )
    await variant.read({ Origin: 'https://a.example' })
    await variant.idle()
    expect((await variant.read({ Origin: 'https://b.example' })).text).toContain(
      'https://b.example',
    )
  })

  it('does not replay a representation whose final status or body was replaced', async () => {
    let renders = 0
    const { read } = await fixture(
      { loader: () => ++renders },
      {
        app: {
          middleware: [
            async (ctx, next) => {
              await next()
              ctx.res = new Response('replacement', { status: 503 })
            },
          ],
        },
      },
    )
    expect((await read()).response.status).toBe(503)
    expect((await read()).text).toBe('replacement')
    expect(renders).toBe(2)
  })

  it('does not share private output with concurrent waiters', async () => {
    const entered = barrier()
    const release = barrier()
    let renders = 0
    const { read } = await fixture(
      {
        loader: async () => {
          if (++renders === 1) {
            entered.resolve()
            await release.promise
          }
          return renders
        },
      },
      {
        app: {
          middleware: [
            async (ctx, next) => {
              await next()
              ctx.header('Set-Cookie', 'personal=1')
            },
          ],
        },
      },
    )
    const first = read()
    await entered.promise
    const second = read()
    release.resolve()
    await Promise.all([first, second])
    expect(renders).toBe(2)
  })

  it('keeps rendering and waiters independent of the first client cancellation', async () => {
    const entered = barrier<AbortSignal>()
    const release = barrier()
    let renders = 0
    const { app, read, idle } = await fixture({
      loader: async ({ signal }) => {
        if (++renders === 1) {
          entered.resolve(signal)
          await release.promise
          signal.throwIfAborted()
        }
        return { version: renders }
      },
    })
    const controller = new AbortController()
    const first = app.fetch(new Request('http://localhost/', { signal: controller.signal }))
    const signal = await entered.promise
    const second = read()
    controller.abort()
    expect(signal.aborted).toBe(false)
    release.resolve()
    await (await first).text()
    await second
    await idle()
    await read()
    expect(renders).toBe(1)
  })

  it('renders normally when another fill has exhausted capacity', async () => {
    const entered = barrier()
    const release = barrier()
    const { read } = await fixture(
      {
        loader: async ({ url }) => {
          if (url.search === '?first') {
            entered.resolve()
            await release.promise
          }
          return { query: url.search }
        },
      },
      { cache: { maxEntries: 1 } },
    )
    const first = read(undefined, '?first')
    await entered.promise
    const second = read(undefined, '?second')
    const timeout = AbortSignal.timeout(1000)
    const failed = new Promise<never>((_, reject) =>
      timeout.addEventListener('abort', () => reject(new Error('capacity bypass hung')), {
        once: true,
      }),
    )
    try {
      expect((await Promise.race([second, failed])).text).toContain('?second')
    } finally {
      release.resolve()
      await first
    }
  })

  it.each([false, true])(
    'invalidates in-flight output before commit (no-cache=%s)',
    async (independent) => {
      const entered = barrier()
      const release = barrier()
      let renders = 0
      const { app, read, idle } = await fixture({
        loader: async () => {
          const version = ++renders
          if (version === 1) {
            entered.resolve()
            await release.promise
          }
          return { version }
        },
      })
      const first = read(independent ? { 'Cache-Control': 'no-cache' } : undefined)
      await entered.promise
      app.cache.revalidatePath('/')
      release.resolve()
      await first
      await idle()
      expect((await read()).text).not.toContain('"version":1')
      expect(renders).toBeGreaterThanOrEqual(2)
    },
  )

  it('invalidates all queries by path and all tagged representations', async () => {
    let renders = 0
    const { app, read, idle } = await fixture({
      cache: { ttl: 60, tags: ['articles'] },
      loader: () => ++renders,
    })
    await read(undefined, '?a')
    await idle()
    await read(undefined, '?b')
    await idle()
    app.cache.revalidatePath('/')
    await read(undefined, '?a')
    await idle()
    await read(undefined, '?b')
    await idle()
    expect(renders).toBe(4)
    app.cache.revalidateTag('articles')
    await read(undefined, '?a')
    await idle()
    expect(renders).toBe(5)
  })

  it.each([false, true])(
    'stores the completed no-cache render for subsequent requests (primed=%s)',
    async (primed) => {
      let renders = 0
      const { read, idle } = await fixture({ loader: () => ({ version: ++renders }) })
      if (primed) {
        await read()
        await idle()
      }
      const previous = primed ? await read() : undefined
      if (previous) expect(previous.response.headers.get('etag')).toMatch(/^W\//)
      const response = await read({
        'Cache-Control': 'no-cache',
        ...(previous ? { 'If-None-Match': previous.response.headers.get('etag')! } : {}),
      })
      expect(response.response.status).toBe(200)
      expect(response.text).toContain(`"version":${primed ? 2 : 1}`)
      await idle()
      const normal = await read()
      expect(normal.text).toBe(response.text)
      await idle()
      expect((await read()).text).toBe(normal.text)
      expect(renders).toBe(primed ? 2 : 1)
    },
  )

  it('keeps shared work alive when an independent no-cache render finishes first', async () => {
    const entered = barrier<AbortSignal>()
    const release = barrier()
    let renders = 0
    const { read, idle } = await fixture({
      loader: async ({ signal }) => {
        const version = ++renders
        if (version === 1) {
          entered.resolve(signal)
          await release.promise
          signal.throwIfAborted()
        }
        return { version }
      },
    })
    const leader = read()
    const signal = await entered.promise
    const waiter = read()
    expect((await read({ 'Cache-Control': 'no-cache' })).text).toContain('"version":2')
    expect(signal.aborted).toBe(false)
    release.resolve()
    for (const result of await Promise.all([leader, waiter]))
      expect(result.text).toContain('"version":1')
    await idle()
    expect((await read()).text).toContain('"version":1')
    expect(renders).toBe(2)
  })

  it.each([2000, 12000])(
    'refreshes stale or expired storage from no-cache at age %dms',
    async (age) => {
      const now = Date.now()
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
      let renders = 0
      const { read, idle } = await fixture({
        cache: { ttl: 1, staleWhileRevalidate: 10 },
        loader: () => ({ version: ++renders }),
      })
      await read()
      await idle()
      clock.mockReturnValue(now + age)
      const refreshed = await read({ 'Cache-Control': 'no-cache' })
      expect(refreshed.text).toContain('"version":2')
      await idle()
      expect((await read()).text).toBe(refreshed.text)
      expect(renders).toBe(2)
    },
  )

  it('invalidates every independent capture of the same cache key', async () => {
    const entered = barrier()
    const release = barrier()
    let renders = 0
    const { app, read, idle } = await fixture({
      cache: { ttl: 60, tags: ['articles'] },
      loader: async () => {
        const version = ++renders
        if (version <= 2) {
          if (version === 2) entered.resolve()
          await release.promise
        }
        return { version }
      },
    })
    const first = read({ 'Cache-Control': 'no-cache' })
    const second = read({ 'Cache-Control': 'no-cache' })
    await entered.promise
    app.cache.revalidateTag('articles')
    release.resolve()
    await Promise.all([first, second])
    await idle()
    expect((await read()).text).toContain('"version":3')
    expect(renders).toBe(3)
  })

  it('keeps shared submission owned when both render paths finish together', async () => {
    const entered = barrier<AbortSignal>()
    const independentEntered = barrier()
    const release = barrier()
    let renders = 0
    const { read, idle } = await fixture({
      loader: async ({ signal }) => {
        const version = ++renders
        if (version === 1) entered.resolve(signal)
        else independentEntered.resolve()
        await release.promise
        signal.throwIfAborted()
        return { version }
      },
    })
    const shared = read()
    const signal = await entered.promise
    const waiter = read()
    const independent = read({ 'Cache-Control': 'no-cache' })
    await independentEntered.promise
    release.resolve()
    const [first, second] = await Promise.all([shared, waiter, independent])
    expect(first.text).toContain('"version":1')
    expect(second.text).toBe(first.text)
    await idle()
    expect(signal.aborted).toBe(false)
    await read()
    expect(renders).toBe(2)
  })

  it('abandons oversized capture while delivering the full original stream', async () => {
    let renders = 0
    const value = 'large-content-'.repeat(1000)
    const { read, idle } = await fixture(
      { loader: () => ({ value, version: ++renders }) },
      { cache: { maxEntryBytes: 100 } },
    )
    expect((await read()).text).toContain(value)
    await idle()
    await read()
    expect(renders).toBe(2)
  })

  it('serves SWR immediately, merges refreshes, and drains the real work on close', async () => {
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    const entered = barrier()
    const release = barrier()
    let renders = 0
    const { app, read, idle } = await fixture({
      cache: { ttl: 1, staleWhileRevalidate: 10 },
      loader: async () => {
        const version = ++renders
        if (version === 2) {
          entered.resolve()
          await release.promise
        }
        return { version }
      },
    })
    await read()
    await idle()
    clock.mockReturnValue(now + 2000)
    const stale = await read()
    await entered.promise
    expect(stale.text).toContain('"version":1')
    expect(stale.response.headers.get('age')).toBe('2')
    const another = await read()
    expect(another.text).toBe(stale.text)
    expect(renders).toBe(2)
    const closing = app.close()
    expect(app.state).toBe('draining')
    expect(applicationLifecycles.get(app)!.pendingRequests).toBeGreaterThan(0)
    release.resolve()
    await closing
    expect(app.state).toBe('closed')
  })

  it('expires beyond the SWR window and stores immediately stale responses when explicitly allowed', async () => {
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    let renders = 0
    const { read, idle } = await fixture({
      cache: { ttl: 1, staleWhileRevalidate: 1 },
      loader: () => ++renders,
    })
    await read()
    await idle()
    clock.mockReturnValue(now + 3000)
    await read()
    expect(renders).toBe(2)
    await idle()
    const stale = await fixture(
      { loader: () => ({ value: 'public' }) },
      {
        app: {
          middleware: [
            async (ctx, next) => {
              await next()
              ctx.header('Cache-Control', 'public,max-age=0,stale-while-revalidate=10')
            },
          ],
        },
      },
    )
    await stale.read()
    await stale.idle()
    expect((await stale.read()).response.headers.has('age')).toBe(true)
  })
})

it('streams the cold shell before the complete cached representation exists', async () => {
  const release = barrier()
  let renders = 0
  function SlowContent() {
    use(release.promise)
    return createElement('p', null, 'completed content')
  }
  const { app, read, idle } = await fixture({
    loader: () => ++renders,
    component: () =>
      createElement(
        Suspense,
        { fallback: createElement('p', null, 'loading content') },
        createElement(SlowContent),
      ),
  })
  const response = await app.fetch(new Request('http://localhost/'))
  const reader = response.body!.getReader()
  try {
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toContain('loading content')
    release.resolve()
    while (!(await reader.read()).done) {}
    await idle()
    expect((await read()).text).toContain('completed content')
    expect(renders).toBe(1)
  } finally {
    release.resolve()
    reader.releaseLock()
  }
})
