import { createWorkerHandler } from '@olivaw/sark/runtime/cloudflare'
import { createApp } from '@olivaw/sark/server'
import { describe, expect, it } from 'vitest'

import { generateProject } from '../../src/tooling/vite'
import { createProject } from '../helpers/project'

async function withPage(
  page: string,
  run: (fetch: (request: Request) => Promise<Response>) => Promise<void>,
  files: Record<string, string> = {},
) {
  const project = createProject()
  project.write('app.ts', '')
  project.write('app/index.tsx', page)
  for (const [path, contents] of Object.entries(files)) project.write(path, contents)
  generateProject(project.root)
  try {
    const { definition } = await import(project.root + '/.build/app.ts')
    const worker = createWorkerHandler(definition, true)
    await run((request) =>
      worker.fetch(request, {}, { waitUntil() {}, passThroughOnException() {} }),
    )
  } finally {
    project.remove()
  }
}

const request = (headers?: HeadersInit) => new Request('https://example.test/', { headers })

describe('page preparation and HTTP policy', () => {
  it('preserves native Hono protocol errors raised by a loader', async () => {
    await withPage(
      `import { HTTPException } from 'hono/http-exception'
export function loader() { throw new HTTPException(403, { message: 'Permission denied' }) }
export default function Page() { return <p>Private page</p> }`,
      async (fetch) => {
        const response = await fetch(request())
        expect(response.status).toBe(403)
        const html = await response.text()
        expect(html).toContain('Permission denied')
        expect(html).not.toContain('Private page')
      },
    )
  })

  it.each([
    { mode: 'local', declaration: '', expected: { sub: 'reader', roles: ['read'] } },
    {
      mode: 'remote',
      declaration: "api: { serverUrl: 'https://api.example.test/api' }",
      expected: null,
    },
    {
      mode: 'custom',
      declaration: "identity: () => ({ user: { sub: 'custom' } })",
      expected: { sub: 'custom' },
    },
  ])(
    'selects the display identity from the documented source in $mode mode',
    async ({ declaration, expected }) => {
      await withPage(
        `export function loader({ identity }) { return identity }
export default function Page() { return <p>Identity page</p> }`,
        async (fetch) => {
          const response = await fetch(request())
          expect(response.status).toBe(200)
          const html = await response.text()
          const payload = JSON.parse(
            html.match(
              /<script id="__PAGE_CONTEXT__" type="application\/json">(.*?)<\/script>/s,
            )![1],
          )
          expect(payload.request.identity).toEqual({ user: expected })
          expect(payload.request.scopes['page:'].data).toEqual({ user: expected })
          expect(html).not.toContain('private-claim')
        },
        {
          'app.ts': `import { defineApp } from '@olivaw/sark/server'
import { definePage } from '@olivaw/sark/page'
export const app = defineApp({ middleware: [async (ctx, next) => {
  ctx.set('auth', { identity: { sub: 'reader', roles: ['read'], claims: { internal: 'private-claim' } } })
  await next()
}] })
export const page = definePage({ ${declaration} })`,
        },
      )
    },
  )

  it.each([403, 404])(
    'preserves HTTP %s raised inside Suspense before committing the shell',
    async (status) => {
      await withPage(
        `import { Suspense } from 'react'
import { notFound } from '@olivaw/sark/page'
import { HttpError } from '@olivaw/sark/http'
function Failure() { ${status === 404 ? "notFound('Missing component')" : "throw new HttpError(403, 'Component forbidden')"} }
export default function Page() { return <Suspense fallback={<p>Client recovery</p>}><Failure /></Suspense> }`,
        async (fetch) => {
          const response = await fetch(request())
          expect(response.status).toBe(status)
          expect(response.headers.get('cache-control')).toBe('no-store')
          expect(await response.text()).toContain('Client recovery')
        },
      )
    },
  )

  it('preserves a redirect raised inside Suspense before committing the shell', async () => {
    await withPage(
      `import { Suspense } from 'react'
import { redirect } from '@olivaw/sark/page'
function Redirect() { redirect('/destination') }
export default function Page() { return <Suspense fallback={<p>Client recovery</p>}><Redirect /></Suspense> }`,
      async (fetch) => {
        const response = await fetch(request())
        expect(response.status).toBe(302)
        expect(response.headers.get('location')).toBe('/destination')
        expect(await response.text()).toBe('')
      },
    )
  })

  it('uses the outer visible error status when parallel scopes fail', async () => {
    await withPage(
      `import { HttpError } from '@olivaw/sark/http'
export function loader() { throw new HttpError(404, 'Leaf missing') }
export default function Page() { return <p>Leaf</p> }`,
      async (fetch) => {
        const response = await fetch(request())
        expect(response.status).toBe(401)
        const html = await response.text()
        expect(html).toContain('Outer authorization required')
        expect(html.split('<script')[0]).not.toContain('Leaf missing')
      },
      {
        'app/_layout.tsx': `import { HttpError } from '@olivaw/sark/http'
import { Outlet } from '@olivaw/sark/client'
export function loader() { throw new HttpError(401, 'Outer authorization required') }
export default function Layout() { return <Outlet /> }`,
      },
    )
  })

  it('rejects a suspended component API call that tries to set cookies after the shell', async () => {
    await withPage(
      `import { Suspense } from 'react'
let client
export function loader(args) { client = args.client }
async function Deferred() {
  await new Promise(resolve => setTimeout(resolve, 20))
  try { await client.get('/session'); return <p>Unexpected cookie success</p> }
  catch (error) { return <p>{error.message}</p> }
}
export default function Page() { return <Suspense fallback={<p>Loading session</p>}><Deferred /></Suspense> }`,
      async (fetch) => {
        const response = await fetch(request())
        expect(response.status).toBe(200)
        expect(response.headers.getSetCookie()).toEqual([])
        const html = await response.text()
        expect(html).toContain('Loading session')
        expect(html).toContain(
          'Cannot forward API cookies after response headers have been committed.',
        )
        expect(html).not.toContain('Unexpected cookie success')
      },
      {
        'api/session.get.ts': `import { route, setCookie } from '@olivaw/sark/server'
export default route().handler(ctx => { setCookie(ctx, 'session', 'late'); return { ok: true } })`,
      },
    )
  })

  it('replaces a failed React shell with an independent error document', async () => {
    await withPage(
      `export default function Page() { throw new Error('private component failure') }`,
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

  it('catches metadata errors in their scope and preserves outer loader output', async () => {
    await withPage(
      `export function meta() { throw new Error('private metadata failure') }
export default function Page() { return <p>Unreachable page</p> }`,
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
        'app/_layout.tsx': `import { Outlet } from '@olivaw/sark/client'
export function loader() { return 'Outer data' }
export default function Layout({ data }) { return <main><h1>{data}</h1><Outlet /></main> }`,
      },
    )
  })

  it('contains serialization failure before commitment with an independent complete document', async () => {
    await withPage(
      `export function loader() { const data = { self: null }; data.self = data; return data }
export default function Page() { return <p>Page</p> }`,
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
      `export async function loader({ client }) { return client.get('/me') }
export default function Page() { return <p>Private</p> }`,
      async (fetch) => {
        const response = await fetch(request())
        expect(response.status).toBe(401)
        expect(response.headers.get('location')).toBeNull()
        expect(await response.text()).toContain('Error 401')
      },
      {
        'api/me.get.ts': `import { route, HttpError } from '@olivaw/sark/server'
export default route().handler(() => { throw new HttpError(401, 'Authentication required') })`,
      },
    )
  })

  it.each(['private, max-age=10', 'no-store', 'no-cache'])(
    'preserves restrictive API policy %s over public page declarations',
    async (policy) => {
      await withPage(
        `export const cache = { ttl: 60, staleWhileRevalidate: 120, vary: ['Accept-Language'] }
export async function loader({ client }) { return client.get('/article') }
export default function Page({ data }) { return <h1>{data.title}</h1> }`,
        async (fetch) => {
          const response = await fetch(request())
          expect(response.status).toBe(200)
          expect(response.headers.get('cache-control')).toContain(policy.split(',')[0])
          expect(response.headers.get('cache-control')).not.toContain('public')
          expect(response.headers.get('vary')).toContain('Accept-Language')
          expect(await response.text()).toContain('<h1>Article</h1>')
        },
        {
          'api/article.get.ts': `import { route } from '@olivaw/sark/server'
export default route().handler(ctx => { ctx.header('Cache-Control', ${JSON.stringify(policy)}); return { title: 'Article' } })`,
        },
      )
    },
  )

  it('preserves multiple internal cookies and prevents public caching', async () => {
    await withPage(
      `export const cache = { ttl: 60 }
export async function loader({ client }) { return client.get('/article') }
export default function Page({ data }) { return <h1>{data.title}</h1> }`,
      async (fetch) => {
        const response = await fetch(request())
        expect(response.headers.getSetCookie()).toHaveLength(2)
        expect(response.headers.get('cache-control')).toBe('private, no-store')
      },
      {
        'api/article.get.ts': `import { route, setCookie } from '@olivaw/sark/server'
export default route().handler(ctx => { setCookie(ctx, 'one', '1'); setCookie(ctx, 'two', '2'); return { title: 'Article' } })`,
      },
    )
  })

  it('inherits public TTL and resets inherited cache declarations with false', async () => {
    await withPage(
      `export const cache = { staleWhileRevalidate: 120, vary: ['Accept-Language'] }
export default function Page() { return <h1>Public</h1> }`,
      async (fetch) => {
        const response = await fetch(request())
        expect(response.headers.get('cache-control')).toBe(
          'public, max-age=60, s-maxage=60, stale-while-revalidate=120',
        )
        expect(response.headers.get('vary')).toContain('Accept-Language')
        const privateResponse = await fetch(request({ Cookie: 'visitor=abc' }))
        expect(privateResponse.headers.get('cache-control')).toBe('private, no-store')
      },
      {
        'app/_layout.tsx': `import { Outlet } from '@olivaw/sark/client'
export const cache = { ttl: 60 }
export default function Layout() { return <Outlet /> }`,
      },
    )
    await withPage(
      'export const cache = false; export default function Page() { return <h1>Dynamic</h1> }',
      async (fetch) => {
        expect((await fetch(request())).headers.get('cache-control')).toBe('no-store')
      },
      {
        'app/_layout.tsx': `import { Outlet } from '@olivaw/sark/client'
export const cache = { ttl: 60 }
export default function Layout() { return <Outlet /> }`,
      },
    )
  })

  it('prepares HEAD status and cache headers without returning a render stream', async () => {
    await withPage(
      `export const cache = { ttl: 30 }
export default function Page() { return <h1>Head response</h1> }`,
      async (fetch) => {
        const response = await fetch(new Request('https://example.test/', { method: 'HEAD' }))
        expect(response.status).toBe(200)
        expect(response.body).toBeNull()
        expect(response.headers.get('content-type')).toContain('text/html')
        expect(response.headers.get('cache-control')).toBe('public, max-age=30, s-maxage=30')
      },
    )
  })

  it('rejects API/page GET collisions during generation, including differently named parameters', () => {
    const project = createProject()
    try {
      project.write('app.ts', '')
      project.write('app/[id].tsx', 'export default function Page() { return <h1>Page</h1> }')
      project.write(
        'api/[name].get.ts',
        "import { route } from '@olivaw/sark/server'; export default route().handler(() => 'api')",
      )
      expect(() => generateProject(project.root, { apiPrefix: '/' })).toThrow('Route conflict')
    } finally {
      project.remove()
    }
  })

  it('delivers decoded single parameters and wildcard arrays through real Hono page matching', async () => {
    const project = createProject()
    try {
      project.write('app.ts', '')
      project.write(
        'app/files/[...path].tsx',
        'export default function Page({ params }) { return <h1>{JSON.stringify(params.path)}</h1> }',
      )
      generateProject(project.root)
      const { definition } = await import(project.root + '/.build/app.ts')
      const app = await createApp(definition)
      try {
        const response = await app.fetch(
          new Request('https://example.test/files/hello%20world/second'),
        )
        expect(response.status).toBe(200)
        const html = await response.text()
        const bootstrap = JSON.parse(
          html.match(/<script id="__PAGE_CONTEXT__" type="application\/json">(.*?)<\/script>/s)![1],
        )
        expect(bootstrap.request.params.path).toEqual(['hello world', 'second'])
      } finally {
        await app.close()
      }
    } finally {
      project.remove()
    }
  })

  it('uses native scope-only middleware policy and preserves canonical URL redirects', async () => {
    const project = createProject()
    project.write(
      'app.ts',
      `import { defineApp } from '@olivaw/sark/server'; export const app = defineApp({ cors: { origin: 'https://consumer.test' } })`,
    )
    project.write('app/_middleware.ts', 'export const scope = { cors: false }')
    project.write(
      'app/posts/[id].tsx',
      'export default function Page({ params }) { return <h1>{params.id}</h1> }',
    )
    generateProject(project.root)
    const { definition } = await import(project.root + '/.build/app.ts')
    const app = await createApp(definition)
    try {
      const response = await app.fetch(
        new Request('https://example.test/POSTS/Hello', {
          headers: { Origin: 'https://consumer.test' },
        }),
      )
      expect(response.status).toBe(308)
      expect(response.headers.get('location')).toBe('https://example.test/posts/Hello')
      const canonical = await app.fetch(new Request(response.headers.get('location')!))
      expect(canonical.status).toBe(200)
      expect(await canonical.text()).toContain('<h1>Hello</h1>')
      expect(response.headers.get('access-control-allow-origin')).toBeNull()
    } finally {
      await app.close()
      project.remove()
    }
  })
})
