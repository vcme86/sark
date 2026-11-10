import { describe, expect, it, vi } from 'vitest'

import { resolveHttpConfig } from '../../src/app/config'
import { ensureVisitor } from '../../src/entries/visitors'
import { createVisitorsAssembly } from '../../src/features/visitors/assembly'
import {
  DEFAULT_VISITORS_CONFIG,
  defineVisitors,
  resolveVisitorsConfig,
} from '../../src/features/visitors/config'
import { VisitorError } from '../../src/features/visitors/error'

const SECRET = 'test-visitor-signing-secret-with-32-bytes-or-more'

describe('Visitors Unit Tests', () => {
  describe('resolveVisitorsConfig', () => {
    it('materializes defaults and preserves the independent secret', () => {
      const resolved = resolveVisitorsConfig({ secret: SECRET }, {})
      expect(resolved.secret).toBe(SECRET)
      expect(resolved.cookieName).toBe(DEFAULT_VISITORS_CONFIG.cookieName)
      expect(resolved.expiresIn).toBe(DEFAULT_VISITORS_CONFIG.expiresIn)
      expect(resolved.path).toBe(DEFAULT_VISITORS_CONFIG.path)
      expect(resolved.cookie).toEqual({
        path: '/',
        domain: undefined,
        sameSite: 'lax',
        secure: false,
        httpOnly: true,
      })
    })

    it('sets secure=true in production mode', () => {
      expect(resolveVisitorsConfig({ secret: SECRET }, {}, true).cookie.secure).toBe(true)
    })

    it('allows overriding optional settings without mutating the input', () => {
      const input = {
        secret: SECRET,
        cookieName: 'custom_visitor_id',
        expiresIn: 86_400_000,
        path: '/custom//visitor/init/',
        cookie: {
          path: '/custom',
          domain: 'example.com',
          sameSite: 'strict' as const,
          secure: true,
        },
      }
      const resolved = resolveVisitorsConfig(input, {})
      expect(resolved).toEqual({
        ...input,
        path: '/custom/visitor/init',
        cookie: { ...input.cookie, httpOnly: true },
      })
      expect(input.path).toBe('/custom//visitor/init/')
      expect(input.cookie).not.toHaveProperty('httpOnly')
    })

    it('evaluates the environment factory with the supplied environment', () => {
      const resolved = resolveVisitorsConfig(
        (env: { SECRET: string }) => ({ secret: env.SECRET, expiresIn: 10_000 }),
        { SECRET },
      )
      expect(resolved.secret).toBe(SECRET)
      expect(resolved.expiresIn).toBe(10_000)
    })

    it.each([undefined, '', 's', 'a'.repeat(31)])(
      'rejects missing or short secrets: %s',
      (secret) => {
        expect(() => resolveVisitorsConfig({ secret }, {})).toThrow('at least 32 UTF-8 bytes')
      },
    )

    it('measures secret length in UTF-8 bytes and preserves whitespace', () => {
      const secret = '密'.repeat(11)
      expect(resolveVisitorsConfig({ secret }, {}).secret).toBe(secret)
      const spacedSecret = ` ${SECRET} `
      expect(resolveVisitorsConfig({ secret: spacedSecret }, {}).secret).toBe(spacedSecret)
    })

    it.each(['bad;cookie', 'bad cookie', 'bad=cookie', 'bad(cookie)', '访客'])(
      'rejects cookie names unsupported by the selected serializer: %s',
      (cookieName) => {
        expect(() => resolveVisitorsConfig({ secret: SECRET, cookieName }, {})).toThrow(
          'Invalid visitors cookie configuration',
        )
      },
    )

    it('validates cookie prefixes and attributes before requests', () => {
      expect(() =>
        resolveVisitorsConfig({ secret: SECRET, cookieName: '__Host-visitor' }, {}),
      ).toThrow('Invalid visitors cookie configuration')
      expect(() =>
        resolveVisitorsConfig(
          {
            secret: SECRET,
            cookieName: '__Host-visitor',
            cookie: { secure: true, domain: 'example.com' },
          },
          {},
        ),
      ).toThrow('Invalid visitors cookie configuration')
      expect(() =>
        resolveVisitorsConfig({ secret: SECRET, cookie: { path: '/app;unsafe' } }, {}),
      ).toThrow('Invalid visitors cookie configuration')
      expect(() =>
        resolveVisitorsConfig({ secret: SECRET, cookie: { domain: 'example.com;unsafe' } }, {}),
      ).toThrow('Invalid visitors cookie configuration')
      expect(
        resolveVisitorsConfig(
          { secret: SECRET, cookieName: '__Host-visitor', cookie: { secure: true } },
          {},
        ).cookieName,
      ).toBe('__Host-visitor')
    })

    it.each([0, -100, 12.34, 999, 34_560_000_001, Infinity, NaN])(
      'rejects an unsupported lifetime: %s',
      (expiresIn) => {
        expect(() => resolveVisitorsConfig({ secret: SECRET, expiresIn }, {})).toThrow(
          'integer from 1000 to 34560000000 milliseconds',
        )
      },
    )

    it.each([1_000, 1_001, 34_560_000_000])('preserves a valid lifetime: %s', (expiresIn) => {
      expect(resolveVisitorsConfig({ secret: SECRET, expiresIn }, {}).expiresIn).toBe(expiresIn)
    })

    it.each([
      'relative/path',
      '//example.com/init',
      '/init?x=1',
      '/init#part',
      '/init/:id',
      '/init/*',
      '/a/../init',
      '/init with space',
      '/init\\path',
    ])('rejects non-static initialization paths: %s', (path) => {
      expect(() => resolveVisitorsConfig({ secret: SECRET, path }, {})).toThrow(
        'absolute static path',
      )
    })

    it('allows an explicit root POST endpoint', () => {
      expect(resolveVisitorsConfig({ secret: SECRET, path: '/' }, {}).path).toBe('/')
    })

    it('rejects a relative cookie scope', () => {
      expect(() =>
        resolveVisitorsConfig({ secret: SECRET, cookie: { path: 'relative/cookie' } }, {}),
      ).toThrow('Visitors cookie.path must be an absolute path')
    })

    it('enforces secure=true when sameSite is none', () => {
      expect(
        resolveVisitorsConfig({ secret: SECRET, cookie: { sameSite: 'none' } }, {}, false).cookie
          .secure,
      ).toBe(true)
      expect(() =>
        resolveVisitorsConfig({ secret: SECRET, cookie: { sameSite: 'none', secure: false } }, {}),
      ).toThrow('requires secure=true')
    })
  })

  describe('createVisitorsAssembly runtime caching', () => {
    it('caches static configuration across prepare calls in the same runtime', async () => {
      let reads = 0
      const assembly = createVisitorsAssembly(
        defineVisitors({
          get secret() {
            reads++
            return SECRET
          },
        }),
      )
      const runtime = assembly.createRuntime()
      expect(reads).toBe(0)

      const config = resolveHttpConfig({}, false)
      await runtime.prepare({}, config)
      const initial = reads
      expect(initial).toBeGreaterThan(0)

      await runtime.prepare({ OTHER: true }, config)
      expect(reads).toBe(initial)

      // A different runtime evaluates again
      await assembly.createRuntime().prepare({}, config)
      expect(reads).toBeGreaterThan(initial)
    })

    it('evaluates dynamic environment factory on each prepare call', async () => {
      let envCalls = 0
      const assembly = createVisitorsAssembly(
        defineVisitors((env: { KEY: string }) => {
          envCalls++
          return {
            secret: env.KEY,
          }
        }),
      )
      const runtime = assembly.createRuntime()
      const config = resolveHttpConfig({}, false)

      await runtime.prepare({ KEY: `${SECRET}-1` }, config)
      expect(envCalls).toBe(1)

      await runtime.prepare({ KEY: `${SECRET}-2` }, config)
      expect(envCalls).toBe(2)
    })

    it('reuses RouteEntry object reference across prepare calls with the same endpoint path', async () => {
      const assembly = createVisitorsAssembly(defineVisitors({ secret: SECRET }))
      const runtime = assembly.createRuntime()
      const config = resolveHttpConfig({}, false)

      const prep1 = await runtime.prepare({}, config)
      const prep2 = await runtime.prepare({ OTHER_ENV: '1' }, config)

      // Object identity must be preserved so that createApp / Workers does not recompile Hono router
      expect(prep1.routes).toBe(prep2.routes)
      expect(prep1.routes![0]).toBe(prep2.routes![0])
    })

    it('recompiles RouteEntry only when endpoint path actually changes', async () => {
      let currentPath = '/init-1'
      const assembly = createVisitorsAssembly(
        defineVisitors((env: { PATH?: string }) => ({
          secret: SECRET,
          path: env.PATH ?? currentPath,
        })),
      )
      const runtime = assembly.createRuntime()
      const config = resolveHttpConfig({}, false)

      const prep1 = await runtime.prepare({ PATH: '/init-1' }, config)
      const prep2 = await runtime.prepare({ PATH: '/init-1' }, config)
      const prep3 = await runtime.prepare({ PATH: '/init-2' }, config)

      expect(prep1.routes).toBe(prep2.routes)
      expect(prep3.routes).not.toBe(prep1.routes)
      expect(prep3.routes![0].routePath.urlPath).toBe('/init-2')
    })
  })

  describe('VisitorError', () => {
    it('defaults to status 500 and response_committed code', () => {
      const err = new VisitorError('test error')
      expect(err.status).toBe(500)
      expect(err.code).toBe('response_committed')
      expect(err.message).toBe('test error')
    })
  })

  describe('ensureVisitor browser helper unit tests', () => {
    it('uses the standalone default when no startup element exists', async () => {
      const fetchMock = vi.fn(async () => new Response(null, { status: 204 }))
      vi.stubGlobal('fetch', fetchMock)
      vi.stubGlobal('document', { getElementById: () => null })
      try {
        await ensureVisitor()
        expect(fetchMock).toHaveBeenCalledWith(
          '/__sark/visitor',
          expect.objectContaining({ method: 'POST', credentials: 'same-origin' }),
        )
      } finally {
        vi.unstubAllGlobals()
      }
    })

    it('reads a custom endpoint from startup data', async () => {
      const fetchMock = vi.fn(async () => new Response(null, { status: 204 }))
      vi.stubGlobal('fetch', fetchMock)
      vi.stubGlobal('document', {
        getElementById: () => ({
          textContent: JSON.stringify({ config: { visitorPath: '/configured/init' } }),
        }),
      })
      try {
        await ensureVisitor()
        expect(fetchMock).toHaveBeenCalledWith(
          '/configured/init',
          expect.objectContaining({ method: 'POST' }),
        )
      } finally {
        vi.unstubAllGlobals()
      }
    })

    it.each(['{', ''])(
      'rejects malformed startup JSON before sending a request: %s',
      async (textContent) => {
        const fetchMock = vi.fn(async () => new Response(null, { status: 204 }))
        vi.stubGlobal('fetch', fetchMock)
        vi.stubGlobal('document', { getElementById: () => ({ textContent }) })
        try {
          await expect(ensureVisitor()).rejects.toBeInstanceOf(SyntaxError)
          expect(fetchMock).not.toHaveBeenCalled()
          await ensureVisitor({ url: '/explicit/init' })
          expect(fetchMock).toHaveBeenCalledTimes(1)
        } finally {
          vi.unstubAllGlobals()
        }
      },
    )

    it('strictly requires 204 status and rejects 200 HTML or other status codes', async () => {
      const originalFetch = globalThis.fetch
      try {
        globalThis.fetch = async () =>
          new Response('<html>Not found or SPA fallback</html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          })

        await expect(ensureVisitor({ url: '/test/init-html' })).rejects.toThrow(
          'ensureVisitor failed with HTTP status 200: expected 204 No Content',
        )

        globalThis.fetch = async () => new Response(null, { status: 404 })
        await expect(ensureVisitor({ url: '/test/init-404' })).rejects.toThrow(
          'ensureVisitor failed with HTTP status 404: expected 204 No Content',
        )
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    it('coalesces only matching url and credentials modes, differentiating keys', async () => {
      const originalFetch = globalThis.fetch
      const fetchCalls: Array<{ url: string; credentials?: RequestCredentials }> = []

      try {
        let resolveRequest: () => void
        const controlledPromise = new Promise<void>((r) => {
          resolveRequest = r
        })

        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
          fetchCalls.push({ url: String(input), credentials: init?.credentials })
          await controlledPromise
          return new Response(null, { status: 204 })
        }) as typeof fetch

        // 1. Same URL and credentials coalesce into 1 fetch
        const p1 = ensureVisitor({ url: '/test/coalesce', credentials: 'same-origin' })
        const p2 = ensureVisitor({ url: '/test/coalesce', credentials: 'same-origin' })

        // 2. Different credentials mode creates a distinct request
        const p3 = ensureVisitor({ url: '/test/coalesce', credentials: 'include' })

        // 3. Different URL creates a distinct request
        const p4 = ensureVisitor({ url: '/test/other', credentials: 'same-origin' })

        expect(fetchCalls.length).toBe(3)

        resolveRequest!()
        await Promise.all([p1, p2, p3, p4])
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    it('isolates caller signal cancellation without aborting the underlying shared request for others', async () => {
      const originalFetch = globalThis.fetch

      try {
        let resolveRequest: () => void
        const controlledPromise = new Promise<void>((r) => {
          resolveRequest = r
        })

        globalThis.fetch = (async () => {
          await controlledPromise
          return new Response(null, { status: 204 })
        }) as typeof fetch

        const abortCtrl = new AbortController()

        // Caller 1 has signal
        const p1 = ensureVisitor({ url: '/test/cancel-shared', signal: abortCtrl.signal })
        // Caller 2 has no signal
        const p2 = ensureVisitor({ url: '/test/cancel-shared' })

        // Abort caller 1
        abortCtrl.abort(new Error('Caller 1 aborted'))

        await expect(p1).rejects.toThrow('Caller 1 aborted')

        // Caller 2 still successfully resolves when underlying fetch finishes
        resolveRequest!()
        await expect(p2).resolves.toBeUndefined()
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    it('allows retry after fetch rejects', async () => {
      const originalFetch = globalThis.fetch
      let attempts = 0

      try {
        globalThis.fetch = (async () => {
          attempts++
          if (attempts === 1) {
            throw new Error('Network failure')
          }
          return new Response(null, { status: 204 })
        }) as typeof fetch

        // First attempt fails
        await expect(ensureVisitor({ url: '/test/retry' })).rejects.toThrow('Network failure')
        expect(attempts).toBe(1)

        // Second attempt retries and succeeds
        await expect(ensureVisitor({ url: '/test/retry' })).resolves.toBeUndefined()
        expect(attempts).toBe(2)
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    it('rejects a pre-cancelled caller without sending an initialization request', async () => {
      const originalFetch = globalThis.fetch
      let calls = 0
      globalThis.fetch = async () => {
        calls++
        return new Response(null, { status: 204 })
      }
      try {
        const controller = new AbortController()
        const reason = new Error('Initialization cancelled')
        controller.abort(reason)
        await expect(
          ensureVisitor({ url: '/test/pre-cancelled', signal: controller.signal }),
        ).rejects.toBe(reason)
        expect(calls).toBe(0)
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    it('starts a fresh request after cancellation and preserves it while the old request settles', async () => {
      const originalFetch = globalThis.fetch
      const previous = Promise.withResolvers<Response>()
      const replacement = Promise.withResolvers<Response>()
      let calls = 0
      globalThis.fetch = () => (++calls === 1 ? previous.promise : replacement.promise)
      try {
        const controller = new AbortController()
        const reason = new Error('First caller left')
        const first = ensureVisitor({ url: '/test/cancel-retry', signal: controller.signal }).catch(
          (error) => error,
        )
        controller.abort(reason)
        const retry = ensureVisitor({ url: '/test/cancel-retry' })
        expect(calls).toBe(2)

        // Finish the old fetch after its caller has left and the replacement has started.
        previous.reject(reason)
        await previous.promise.catch(() => {})
        expect(await first).toBe(reason)

        const concurrent = ensureVisitor({ url: '/test/cancel-retry' })
        expect(calls).toBe(2)
        replacement.resolve(new Response(null, { status: 204 }))
        await Promise.all([retry, concurrent])
      } finally {
        previous.resolve(new Response(null, { status: 204 }))
        replacement.resolve(new Response(null, { status: 204 }))
        globalThis.fetch = originalFetch
      }
    })
  })
})
