import { HTTPException } from 'hono/http-exception'
import { createElement as h, Suspense } from 'react'
import { describe, expect, it } from 'vitest'

import type { RouteDeclaration } from '../../src/app/http/types'
import type { HttpClient } from '../../src/client/client'
import { HttpError, route, setCookie } from '../../src/entries/root'
import { createAuthAssembly } from '../../src/features/auth/session/assembly'
import { defineAuth } from '../../src/features/auth/session/config'
import { signToken } from '../../src/features/auth/session/token'
import { parseApiFilePath } from '../../src/http/path'
import { Outlet } from '../../src/page/components/outlet'
import { definePage } from '../../src/page/config'
import { useClient } from '../../src/page/hooks'
import { notFound, redirect } from '../../src/page/signals'
import { withPage } from '../helpers/page-app'

const request = (headers?: HeadersInit) => new Request('https://example.test/', { headers })

const page = () => h('h1', null, 'Page')

const layout = () => h(Outlet)

function api(name: string, declaration: RouteDeclaration) {
  return { routePath: parseApiFilePath(`${name}.get.ts`, '/api')!, declaration }
}

function bootstrap(html: string) {
  return JSON.parse(
    html.match(/<script id="__PAGE_CONTEXT__" type="application\/json">(.*?)<\/script>/s)![1],
  )
}

describe('page preparation and HTTP policy', () => {
  it('preserves native Hono protocol errors raised by a loader', async () => {
    await withPage(
      {
        component: page,
        loader() {
          throw new HTTPException(403, { message: 'Permission denied' })
        },
      },
      async (fetch) => {
        const response = await fetch(request())
        expect(response.status).toBe(403)
        const html = await response.text()
        expect(html).toContain('Permission denied')
        expect(html).not.toContain('<h1>Page</h1>')
      },
    )
  })

  it.each([
    { mode: 'local', declaration: undefined, expected: { sub: 'reader', roles: ['read'] } },
    {
      mode: 'remote',
      declaration: definePage({ api: { serverUrl: 'https://api.example.test/api' } }),
      expected: null,
    },
    {
      mode: 'custom',
      declaration: definePage({
        identity: () => ({ user: { sub: 'custom', accessToken: 'private-claim' } }),
      }),
      expected: { sub: 'custom' },
    },
  ])('selects the documented display identity in $mode mode', async ({ declaration, expected }) => {
    const secret = 'a-shared-test-secret-with-at-least-thirty-two-characters'
    const token = await signToken(
      { sub: 'reader', roles: ['read'], claims: { internal: 'private-claim' } },
      { secret },
    )
    await withPage(
      { component: page, loader: ({ identity }) => identity },
      async (fetch) => {
        const response = await fetch(request({ Authorization: `Bearer ${token}` }))
        expect(response.status).toBe(200)
        const html = await response.text()
        const payload = bootstrap(html)
        expect(payload.request.identity).toEqual(expected ? { user: expected } : undefined)
        expect(payload.request.scopes['page:'].data).toEqual({ user: expected })
        expect(html).not.toContain('private-claim')
      },
      { page: declaration, services: { auth: createAuthAssembly(defineAuth({ secret })) } },
    )
  })

  it.each([403, 404])(
    'preserves HTTP %s raised inside Suspense before shell commitment',
    async (status) => {
      const Failure = () => {
        if (status === 404) notFound('Missing component')
        throw new HttpError(403, 'Component forbidden')
      }
      await withPage(
        { component: () => h(Suspense, { fallback: h('p', null, 'Client recovery') }, h(Failure)) },
        async (fetch) => {
          const response = await fetch(request())
          expect(response.status).toBe(status)
          expect(response.headers.get('cache-control')).toBe('no-store')
          expect(await response.text()).toContain('Client recovery')
        },
      )
    },
  )

  it('preserves a redirect raised inside Suspense before shell commitment', async () => {
    const location = '/destination'
    const Redirect = () => redirect(location)
    await withPage(
      { component: () => h(Suspense, { fallback: 'Redirecting' }, h(Redirect)) },
      async (fetch) => {
        const response = await fetch(request())
        expect(response.status).toBe(302)
        expect(response.headers.get('location')).toBe(location)
        expect(await response.text()).toBe('')
      },
    )
  })

  it('uses the outer visible error status when parallel scopes fail', async () => {
    await withPage(
      {
        component: page,
        loader() {
          throw new HttpError(404, 'Leaf missing')
        },
      },
      async (fetch) => {
        const response = await fetch(request())
        expect(response.status).toBe(401)
        const html = await response.text()
        expect(html).toContain('Outer authorization required')
        expect(html.split('<script')[0]).not.toContain('Leaf missing')
      },
      {
        layouts: [
          {
            id: 'layout',
            component: layout,
            loader() {
              throw new HttpError(401, 'Outer authorization required')
            },
          },
        ],
      },
    )
  })

  it('rejects a suspended component API call that sets cookies after the shell', async () => {
    const release = Promise.withResolvers<void>()
    async function Deferred({ client }: { client: HttpClient<unknown> }) {
      await release.promise
      try {
        await client.get('/session')
        return h('p', null, 'Unexpected cookie success')
      } catch (error) {
        return h('p', null, (error as Error).message)
      }
    }
    function Page() {
      return h(
        Suspense,
        { fallback: 'Loading session' },
        h(Deferred, { client: useClient<unknown>() }),
      )
    }
    try {
      await withPage(
        { component: Page },
        async (fetch) => {
          const response = await fetch(request())
          expect(response.status).toBe(200)
          expect(response.headers.getSetCookie()).toEqual([])
          release.resolve()
          const html = await response.text()
          expect(html).toContain('Loading session')
          expect(html).toContain(
            'Cannot forward API cookies after response headers have been committed.',
          )
          expect(html).not.toContain('Unexpected cookie success')
        },
        {
          routes: [
            api(
              'session',
              route().handler((ctx) => {
                setCookie(ctx, 'session', 'late')
                return { ok: true }
              }),
            ),
          ],
        },
      )
    } finally {
      release.resolve()
    }
  })

  it('replaces a failed React shell with an independent error document', async () => {
    await withPage(
      {
        component() {
          throw new Error('private component failure')
        },
      },
      async (fetch) => {
        const response = await fetch(request())
        expect(response.status).toBe(500)
        const html = await response.text()
        expect(html).toMatch(/^<!DOCTYPE html><html>/)
        expect(html).toContain('Internal Server Error')
        expect(html).not.toContain('private component failure')
        expect(html).toMatch(/<\/body><\/html>$/)
      },
    )
  })

  it('contains metadata errors in their scope and preserves outer loader output', async () => {
    await withPage(
      {
        component: () => h('p', null, 'Unreachable page'),
        meta() {
          throw new Error('private metadata failure')
        },
      },
      async (fetch) => {
        const response = await fetch(request())
        const html = await response.text()
        expect(response.status).toBe(500)
        expect(html).toContain('Outer data')
        expect(html).toContain('Internal Server Error')
        expect(html).not.toContain('private metadata failure')
        expect(html).not.toContain('Unreachable page')
        expect(response.headers.get('cache-control')).toBe('no-store')
      },
      {
        layouts: [
          {
            id: 'layout',
            component: ({ data }) => h('main', null, h('h1', null, data), h(Outlet)),
            loader: () => 'Outer data',
          },
        ],
      },
    )
  })

  it('contains serialization failure before commitment with a complete error document', async () => {
    await withPage(
      {
        component: page,
        loader() {
          const data: { self?: unknown } = {}
          data.self = data
          return data
        },
      },
      async (fetch) => {
        const response = await fetch(request())
        const html = await response.text()
        expect(response.status).toBe(500)
        expect(html).toMatch(/^<!DOCTYPE html><html>/)
        expect(html).toContain('Internal Server Error')
        expect(html).not.toContain('circular')
        expect(html).toMatch(/<\/body><\/html>$/)
      },
    )
  })

  it('keeps API 401 errors as scoped errors without a login redirect', async () => {
    await withPage(
      { component: page, loader: ({ client }) => client.get('/me') },
      async (fetch) => {
        const response = await fetch(request())
        expect(response.status).toBe(401)
        expect(response.headers.get('location')).toBeNull()
        expect(await response.text()).toContain('Error 401')
      },
      {
        routes: [
          api(
            'me',
            route().handler(() => {
              throw new HttpError(401, 'Authentication required')
            }),
          ),
        ],
      },
    )
  })

  it.each(['private, max-age=10', 'no-store', 'no-cache'])(
    'preserves restrictive API policy %s over public declarations',
    async (policy) => {
      await withPage(
        {
          component: ({ data }) => h('h1', null, data.title),
          cache: { ttl: 60, staleWhileRevalidate: 120, vary: ['Accept-Language'] },
          loader: ({ client }) => client.get('/article'),
        },
        async (fetch) => {
          const response = await fetch(request())
          expect(response.status).toBe(200)
          expect(response.headers.get('cache-control')).toContain(policy.split(',')[0])
          expect(response.headers.get('cache-control')).not.toContain('public')
          expect(response.headers.get('vary')).toContain('Accept-Language')
          expect(await response.text()).toContain('<h1>Article</h1>')
        },
        {
          routes: [
            api(
              'article',
              route().handler((ctx) => {
                ctx.header('Cache-Control', policy)
                return { title: 'Article' }
              }),
            ),
          ],
        },
      )
    },
  )

  it('preserves multiple internal cookies and prevents public caching', async () => {
    await withPage(
      { component: page, cache: { ttl: 60 }, loader: ({ client }) => client.get('/article') },
      async (fetch) => {
        const response = await fetch(request())
        expect(response.headers.getSetCookie()).toHaveLength(2)
        expect(response.headers.get('cache-control')).toBe('private, no-store')
        await response.text()
      },
      {
        routes: [
          api(
            'article',
            route().handler((ctx) => {
              setCookie(ctx, 'one', '1')
              setCookie(ctx, 'two', '2')
              return { title: 'Article' }
            }),
          ),
        ],
      },
    )
  })

  it('inherits public TTL and keeps Cookie-bearing requests private', async () => {
    await withPage(
      { component: page, cache: { staleWhileRevalidate: 120, vary: ['Accept-Language'] } },
      async (fetch) => {
        const response = await fetch(request())
        expect(response.headers.get('cache-control')).toBe(
          'public, max-age=60, s-maxage=60, stale-while-revalidate=120',
        )
        expect(response.headers.get('vary')).toContain('Accept-Language')
        await response.text()
        const privateResponse = await fetch(request({ Cookie: 'visitor=abc' }))
        expect(privateResponse.headers.get('cache-control')).toBe('private, no-store')
        await privateResponse.text()
      },
      { layouts: [{ id: 'layout', component: layout, cache: { ttl: 60 } }] },
    )
  })

  it('resets inherited cache declarations with false', async () => {
    await withPage(
      { component: page, cache: false },
      async (fetch) => {
        const response = await fetch(request())
        expect(response.headers.get('cache-control')).toBe('no-store')
        await response.text()
      },
      { layouts: [{ id: 'layout', component: layout, cache: { ttl: 60 } }] },
    )
  })

  it('prepares HEAD status and cache headers without returning a render stream', async () => {
    await withPage({ component: page, cache: { ttl: 30 } }, async (fetch) => {
      const response = await fetch(new Request('https://example.test/', { method: 'HEAD' }))
      expect(response.status).toBe(200)
      expect(response.body).toBeNull()
      expect(response.headers.get('content-type')).toContain('text/html')
      expect(response.headers.get('cache-control')).toBe('public, max-age=30, s-maxage=30')
    })
  })
})
