import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { createWorkerHandler } from '../../src/entries/runtime/cloudflare'
import { createApp } from '../../src/entries/server'
import { parseApiFilePath } from '../../src/http/path'
import { generateProject } from '../../src/tooling/build/project'
import { createProject } from '../helpers/project'

describe('Page rendering and delivery', () => {
  it('renders one canonical link after merging layout and page metadata', async () => {
    const project = createProject()
    try {
      project.write('app.ts', '')
      project.write(
        'app/_layout.tsx',
        `import { Outlet } from '@olivaw/sark/client'
export function meta() { return { canonical: 'https://example.test/' } }
export default function Layout() { return <main><Outlet /></main> }`,
      )
      project.write(
        'app/index.tsx',
        `export function meta() {
  return { links: [{ rel: 'canonical', href: 'https://example.test/article' }] }
}
export default function Page() { return <h1>Article</h1> }`,
      )
      generateProject(project.root)
      const { definition } = await import(project.root + '/.build/app.ts')
      const app = await createApp(definition)
      try {
        const response = await app.fetch(new Request('https://example.test/'))
        expect(response.status).toBe(200)
        const html = await response.text()
        expect(html.match(/rel="canonical"/g)).toHaveLength(1)
        expect(html).toContain('href="https://example.test/article"')
        expect(html).not.toContain('href="https://example.test/"')
      } finally {
        await app.close()
      }
    } finally {
      project.remove()
    }
  })

  it('keeps layout and index loader data in independent scopes', async () => {
    const project = createProject()
    try {
      project.write(
        'app.ts',
        `import { defineApp } from '@olivaw/sark/server'
export const app = defineApp({})`,
      )
      project.write(
        'app/_layout.tsx',
        `import { Outlet } from '@olivaw/sark/client'
export async function loader() { return { layout: 'Layout data' } }
export default function Layout({ data }: { data: { layout: string } }) {
  return <main><h1>{data.layout}</h1><Outlet /></main>
}`,
      )
      project.write(
        'app/index.tsx',
        `export async function loader() { return { page: 'Page data' } }
export default function Index({ data }: { data: { page: string } }) {
  return <p>{data.page}</p>
}`,
      )
      generateProject(project.root)
      const { definition } = await import(project.root + '/.build/app.ts')
      const app = await createApp(definition)
      try {
        const response = await app.fetch(new Request('https://example.test/'))
        expect(response.status).toBe(200)
        const html = await response.text()
        expect(html).toContain('<h1>Layout data</h1>')
        expect(html).toContain('<p>Page data</p>')
      } finally {
        await app.close()
      }
    } finally {
      project.remove()
    }
  })

  it('generates .build/client.tsx and executes streaming SSR for layout and page hierarchy', async () => {
    const project = createProject()
    try {
      project.write(
        'app.ts',
        `import { defineApp } from '@olivaw/sark/server'
         export const app = defineApp({})`,
      )

      project.write(
        'api/posts.[id].get.ts',
        `import { route, z } from '@olivaw/sark/server'
         export default route()
           .validate({ params: z.object({ id: z.string() }) })
           .handler(async (_c, { params }) => {
             return { id: params.id, title: 'Post #' + params.id, content: 'Hello World' }
           })`,
      )

      project.write(
        'app/_root.tsx',
        `import React from 'react'
         import { Head, Outlet, Scripts } from '@olivaw/sark/client'
         export default function Root() {
           return (
             <html lang="en">
               <head>
                 <Head />
               </head>
               <body>
                 <div id="app">
                   <Outlet />
                 </div>
                 <Scripts />
               </body>
             </html>
           )
         }`,
      )

      project.write(
        'app/_layout.tsx',
        `import React from 'react'
         import { Outlet } from '@olivaw/sark/client'
         export async function loader() {
           return { siteName: 'Sark Framework' }
         }
         export function meta() {
           return { title: 'Default Sark App' }
         }
         export default function Layout({ data }: any) {
           return (
             <main>
               <nav><h1>{data?.siteName}</h1></nav>
               <Outlet />
             </main>
           )
         }`,
      )

      project.write(
        'app/_error.tsx',
        `import React from 'react'
         import type { ErrorProps } from '@olivaw/sark/client'
         export default function RootError({ error, retry }: ErrorProps) {
           return (
             <div className="error-boundary">
               <h2>Error {error.status ?? 500}</h2>
               <p>{error.message}</p>
             </div>
           )
         }`,
      )

      project.write(
        'app/index.tsx',
        `import React from 'react'
         export function meta() {
           return { title: 'Home - Sark' }
         }
         export default function Home() {
           return <p>Welcome to Home Page</p>
         }`,
      )

      project.write(
        'app/posts/[id].tsx',
        `import React from 'react'
         import { notFound, redirect } from '@olivaw/sark/page'
         export async function loader({ client, params }: any) {
           if (params.id === 'redirect-me') {
             throw redirect('/target-path', 307)
           }
           if (params.id === 'missing') {
             throw notFound('Post not found in database')
           }
           const post = await client.get('/posts/:id', { params })
           return { post }
         }
         export function meta({ data }: any) {
           return { title: data?.post?.title }
         }
         export default function PostDetail({ data }: any) {
           return (
             <article>
               <h2>{data?.post?.title}</h2>
               <p>{data?.post?.content}</p>
             </article>
           )
         }`,
      )

      // Run code generation
      generateProject(project.root, { target: 'node' })

      // Verify .build/client.tsx was created
      const clientTsxPath = project.root + '/.build/client.tsx'
      const clientContent = await import('node:fs').then((fs) =>
        fs.readFileSync(clientTsxPath, 'utf-8'),
      )
      expect(clientContent).toContain('hydratePageApplication')
      expect(clientContent).toContain('/posts/:id')
      expect(clientContent).toContain('load: () => import("../app/posts/[id]")')
      expect(clientContent).toContain('load: () => import("../app/_layout")')
      expect(clientContent).not.toContain('import * as page_')
      expect(clientContent).not.toContain('import * as layout_')

      // Import compiled application definition
      const { definition } = await import(project.root + '/.build/app.ts')
      const app = await createApp(definition)
      try {
        // 1. Test Home page SSR
        const homeRes = await app.fetch(new Request('http://localhost:3000/'))
        expect(homeRes.status).toBe(200)
        expect(homeRes.headers.get('content-type')).toContain('text/html')
        const homeHtml = await homeRes.text()
        expect(homeHtml).toContain('<title>Home - Sark</title>')
        expect(homeHtml).toContain('<h1>Sark Framework</h1>')
        expect(homeHtml).toContain('<p>Welcome to Home Page</p>')
        expect(homeHtml).toContain('id="__PAGE_CONTEXT__"')

        // 2. Test Parallel Loader fetching internal API route
        const postRes = await app.fetch(new Request('http://localhost:3000/posts/101'))
        expect(postRes.status).toBe(200)
        const postHtml = await postRes.text()
        expect(postHtml).toContain('<title>Post #101</title>')
        expect(postHtml).toContain('<h1>Sark Framework</h1>')
        expect(postHtml).toContain('<h2>Post #101</h2>')
        expect(postHtml).toContain('<p>Hello World</p>')

        // 3. Test RedirectSignal handling in SSR
        const redirectRes = await app.fetch(new Request('http://localhost:3000/posts/redirect-me'))
        expect(redirectRes.status).toBe(307)
        expect(redirectRes.headers.get('location')).toBe('/target-path')

        // 4. Test NotFoundSignal handling and scoped _error rendering
        const notFoundRes = await app.fetch(new Request('http://localhost:3000/posts/missing'))
        expect(notFoundRes.status).toBe(404)
        const notFoundHtml = await notFoundRes.text()
        expect(notFoundHtml).toContain('404')
        expect(notFoundHtml).toContain('Post not found in database')
      } finally {
        await app.close()
      }
    } finally {
      project.remove()
    }
  })

  it('renders a discovered page through the generated Worker handler in Node', async () => {
    const project = createProject()
    try {
      project.write(
        'app.ts',
        `import { defineApp } from '@olivaw/sark/server'
         export const app = defineApp({})`,
      )
      project.write(
        'app/index.tsx',
        `import React from 'react'
         export default function Home() { return <h1>Cloudflare SSR</h1> }`,
      )

      generateProject(project.root, { target: 'cloudflare' })

      const workerPath = project.root + '/.build/worker.ts'
      const workerContent = await import('node:fs').then((fs) =>
        fs.readFileSync(workerPath, 'utf-8'),
      )
      expect(workerContent).toContain('import { createWorkerHandler')
      expect(workerContent).toContain('createWorkerHandler(definition, import.meta.env.PROD)')

      const { default: worker } = await import(workerPath)
      const response = await worker.fetch(
        new Request('https://example.test/'),
        {},
        {
          waitUntil() {},
          passThroughOnException() {},
        },
      )
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('text/html')
      expect(await response.text()).toContain('<h1>Cloudflare SSR</h1>')
    } finally {
      project.remove()
    }
  })

  it('safely serializes bootstrap JSON payloads escaping script injection and Unicode separators', async () => {
    const project = createProject()
    try {
      project.write(
        'app.ts',
        `import { defineApp } from '@olivaw/sark/server'
         export const app = defineApp({})`,
      )
      project.write(
        'app/_root.tsx',
        `import React from 'react'
         import { Outlet, Scripts } from '@olivaw/sark/client'
         export default function Root() {
           return <html><head></head><body><Outlet /><Scripts /></body></html>
         }`,
      )
      project.write(
        'app/index.tsx',
        `import React from 'react'
         export async function loader() {
           return { dangerous: '</script><script>alert("pwned")</script>', sep: 'line\\u2028sep\\u2029end' }
         }
         export default function Home({ data }: any) {
           return <p>Safe page</p>
         }`,
      )

      generateProject(project.root, { target: 'node' })
      const { definition } = await import(project.root + '/.build/app.ts')
      const app = await createApp(definition)
      try {
        const res = await app.fetch(new Request('http://localhost:3000/'))
        expect(res.status).toBe(200)
        const html = await res.text()

        // Must escape </script>
        expect(html).not.toContain('</script><script>')
        expect(html).toContain('\\u003c/script')
        // Must escape U+2028 and U+2029
        expect(html).toContain('\\u2028')
        expect(html).toContain('\\u2029')
        const serialized = html.match(
          /<script id="__PAGE_CONTEXT__" type="application\/json">(.*?)<\/script>/s,
        )![1]
        expect(serialized).not.toContain('<')
        const data = JSON.parse(serialized).request.scopes['page:'].data
        expect(data.dangerous).toBe('</script><script>alert("pwned")</script>')
        expect(data.sep).toBe('line\u2028sep\u2029end')
      } finally {
        await app.close()
      }
    } finally {
      project.remove()
    }
  })

  it('recovers from SSR shell error with standalone 500 fallback HTML', async () => {
    const project = createProject()
    try {
      project.write(
        'app.ts',
        `import { defineApp } from '@olivaw/sark/server'
         export const app = defineApp({})`,
      )
      project.write(
        'app/_root.tsx',
        `import React from 'react'
         export default function BrokenRoot() {
           throw new Error('Fatal Root Crash')
         }`,
      )
      project.write(
        'app/index.tsx',
        `import React from 'react'
         export default function Home() { return <div>Home</div> }`,
      )

      generateProject(project.root, { target: 'node' })
      const { definition } = await import(project.root + '/.build/app.ts')
      const app = await createApp(definition)
      try {
        const res = await app.fetch(new Request('http://localhost:3000/'))
        expect(res.status).toBe(500)
        expect(res.headers.get('content-type')).toContain('text/html')
        const html = await res.text()
        expect(html).toContain('Server Error')
        expect(html).toContain('Fatal Root Crash')
      } finally {
        await app.close()
      }
    } finally {
      project.remove()
    }
  })

  it('delivers static build assets with manifest-backed immutable caching and unhashed no-cache in Node', async () => {
    const { createNodeStaticHandler } = await import('../../src/adapter/node/static')

    const project = createProject()
    try {
      const staticDir = join(project.root, 'dist/client')
      mkdirSync(join(staticDir, 'assets'), { recursive: true })
      writeFileSync(join(staticDir, 'assets/client-abc12345.js'), 'console.log("client bundle");')
      writeFileSync(join(staticDir, 'favicon.ico'), 'fake-ico-content')
      writeFileSync(join(staticDir, 'text.txt'), '0123456789abcdefghij')

      const handler = createNodeStaticHandler({
        rootDir: staticDir,
        assets: {
          base: '/',
          files: {
            'assets/client-abc12345.js': { path: 'assets/client-abc12345.js', hashed: true },
            'favicon.ico': { path: 'favicon.ico', hashed: false },
            'text.txt': { path: 'text.txt', hashed: false },
          },
        },
      })

      // 1. Content-hashed JS asset: Cache-Control immutable 1 year
      const hashedReq = new Request('http://localhost:3000/assets/client-abc12345.js')
      const hashedRes = await handler(hashedReq)
      expect(hashedRes).not.toBeNull()
      expect(hashedRes?.status).toBe(200)
      expect(hashedRes?.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
      expect(hashedRes?.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
      const hashedBody = await hashedRes?.text()
      expect(hashedBody).toBe('console.log("client bundle");')

      // 2. Unhashed public asset: Cache-Control no-cache
      const unhashedReq = new Request('http://localhost:3000/favicon.ico')
      const unhashedRes = await handler(unhashedReq)
      expect(unhashedRes).not.toBeNull()
      expect(unhashedRes?.status).toBe(200)
      expect(unhashedRes?.headers.get('cache-control')).toBe('no-cache')
      const etag = unhashedRes?.headers.get('etag')
      expect(etag).toBeDefined()

      // 3. Conditional request: If-None-Match yields 304 Not Modified
      const condReq = new Request('http://localhost:3000/favicon.ico', {
        headers: { 'if-none-match': etag! },
      })
      const condRes = await handler(condReq)
      expect(condRes?.status).toBe(304)

      // 4. A single byte range selects the first ten bytes and returns 206 Partial Content.
      const rangeReq = new Request('http://localhost:3000/text.txt', {
        headers: { range: 'bytes=0-9' },
      })
      const rangeRes = await handler(rangeReq)
      expect(rangeRes?.status).toBe(206)
      expect(rangeRes?.headers.get('content-range')).toBe('bytes 0-9/20')
      const rangeBody = await rangeRes?.text()
      expect(rangeBody).toBe('0123456789')

      // 5. Unmatched request returns null, allowing SSR page fallthrough without SPA fallback
      const missingReq = new Request('http://localhost:3000/posts/101')
      const missingRes = await handler(missingReq)
      expect(missingRes).toBeNull()
    } finally {
      project.remove()
    }
  })

  it('serves build assets when the deployment root is a symbolic link', async () => {
    const { createNodeStaticHandler } = await import('../../src/adapter/node/static')
    const project = createProject()
    try {
      project.write('release/main.js', 'console.log("release")')
      symlinkSync('release', join(project.root, 'current'), 'dir')
      const handler = createNodeStaticHandler({
        rootDir: join(project.root, 'current'),
        assets: { base: '/', files: { 'main.js': { path: 'main.js', hashed: true } } },
      })
      const response = await handler(new Request('https://example.test/main.js'))
      expect(response?.status).toBe(200)
      expect(await response?.text()).toBe('console.log("release")')
    } finally {
      project.remove()
    }
  })

  it('delivers static build assets via Cloudflare Workers ASSETS binding with appropriate caching headers', async () => {
    const { createDefinition } = await import('../../src/entries/runtime/core')

    const mockAssets = {
      async fetch(req: Request) {
        const url = new URL(req.url)
        if (url.pathname === '/assets/entry-xyz789.js') {
          return new Response('console.log("cf entry");', {
            status: 200,
            headers: { 'content-type': 'text/javascript' },
          })
        }
        if (url.pathname === '/robots.txt') {
          return new Response('User-agent: *', {
            status: 200,
            headers: { 'content-type': 'text/plain' },
          })
        }
        return new Response('Not Found', { status: 404 })
      },
    }

    const definition = createDefinition({
      apiPrefix: '/api',
      assets: {
        base: '/',
        files: {
          'assets/entry-xyz789.js': { path: 'assets/entry-xyz789.js', hashed: true },
          'robots.txt': { path: 'robots.txt', hashed: false },
        },
      },
      routes: [
        {
          kind: 'page',
          routePath: parseApiFilePath('about.get.ts', '/')!,
          pageHandler: async () =>
            new Response('<h1>Page SSR Content</h1>', { headers: { 'content-type': 'text/html' } }),
        },
      ],
    })

    const handler = createWorkerHandler(definition)

    const executionCtx = {
      waitUntil: () => {},
      passThroughOnException: () => {},
    }

    const env = {
      ASSETS: mockAssets,
    }

    // 1. Content-hashed chunk from ASSETS: immutable cache
    const hashedReq = new Request('https://worker.dev/assets/entry-xyz789.js')
    const hashedRes = await handler.fetch(hashedReq, env, executionCtx)
    expect(hashedRes.status).toBe(200)
    expect(hashedRes.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(await hashedRes.text()).toBe('console.log("cf entry");')

    // 2. Unhashed public asset from ASSETS: no-cache
    const unhashedReq = new Request('https://worker.dev/robots.txt')
    const unhashedRes = await handler.fetch(unhashedReq, env, executionCtx)
    expect(unhashedRes.status).toBe(200)
    expect(unhashedRes.headers.get('cache-control')).toBe('no-cache')
    expect(await unhashedRes.text()).toBe('User-agent: *')

    // 3. A URL absent from the asset mapping goes directly to the page handler.
    const pageReq = new Request('https://worker.dev/about')
    const pageRes = await handler.fetch(pageReq, env, executionCtx)
    expect(pageRes.status).toBe(200)
    expect(await pageRes.text()).toBe('<h1>Page SSR Content</h1>')
  })

  it('respects webPrefix for discovered page routes and request matching', async () => {
    const project = createProject()
    try {
      project.write(
        'app/index.tsx',
        `import React from 'react'
         export default function SiteIndex() { return <h1>Site Home</h1> }`,
      )
      project.write(
        'app/about.tsx',
        `import React from 'react'
         export default function SiteAbout() { return <h1>Site About</h1> }`,
      )

      generateProject(project.root, { target: 'node', webPrefix: '/site' })
      const { definition } = await import(project.root + '/.build/app.ts')
      const app = await createApp(definition)
      try {
        // Matches /site and /site/about
        const res1 = await app.fetch(new Request('http://localhost:3000/site'))
        expect(res1.status).toBe(200)
        expect(await res1.text()).toContain('Site Home')

        const res2 = await app.fetch(new Request('http://localhost:3000/site/about'))
        expect(res2.status).toBe(200)
        expect(await res2.text()).toContain('Site About')

        // Root / returns 404
        const res3 = await app.fetch(new Request('http://localhost:3000/'))
        expect(res3.status).toBe(404)
      } finally {
        await app.close()
      }
    } finally {
      project.remove()
    }
  })

  it('forwards request cookies and authorization to internal API client during SSR', async () => {
    const project = createProject()
    try {
      project.write(
        'api/session.get.ts',
        `import { route } from '@olivaw/sark/server'
         export default route().handler((c) => ({
           cookie: c.req.header('cookie'),
           auth: c.req.header('authorization'),
         }))`,
      )
      project.write(
        'app/index.tsx',
        `import React from 'react'
         export async function loader({ client }: any) {
           const res = await client.get('/session')
           return { session: res }
         }
         export default function Home({ data }: any) {
           return <div>Cookie: {data.session.cookie} | Auth: {data.session.auth}</div>
         }`,
      )

      generateProject(project.root, { target: 'node' })
      const { definition } = await import(project.root + '/.build/app.ts')
      const app = await createApp(definition)
      try {
        const req = new Request('http://localhost:3000/', {
          headers: {
            cookie: 'session_token=abcdef',
            authorization: 'Bearer jwt_xyz',
          },
        })
        const res = await app.fetch(req)
        expect(res.status).toBe(200)
        const html = await res.text()
        expect(html).toContain('session_token=abcdef')
        expect(html).toContain('Bearer jwt_xyz')
      } finally {
        await app.close()
      }
    } finally {
      project.remove()
    }
  })

  it('masks loader 500 error messages in production Worker handler', async () => {
    const project = createProject()
    try {
      project.write(
        'app/index.tsx',
        `import React from 'react'
         export async function loader() {
           throw new Error('PRIVATE_SERVER_DETAIL')
         }
         export default function Home() { return <div>Home</div> }`,
      )

      generateProject(project.root, { target: 'cloudflare' })
      const { definition } = await import(project.root + '/.build/app.ts')
      const handler = createWorkerHandler(definition, true)

      const res = await handler.fetch(
        new Request('https://worker.dev/'),
        {},
        { waitUntil: () => {}, passThroughOnException: () => {} },
      )
      expect(res.status).toBe(500)
      const html = await res.text()
      expect(html).toContain('Internal Server Error')
      expect(html).not.toContain('PRIVATE_SERVER_DETAIL')
    } finally {
      project.remove()
    }
  })

  it('executes page _middleware.ts chain and intercepts requests before rendering', async () => {
    const project = createProject()
    try {
      project.write(
        'app/_middleware.ts',
        `export default async function mw(c: any, next: any) {
           c.header('x-page-middleware', 'active')
           const url = new URL(c.req?.url ?? c.url)
           if (url.searchParams.has('block')) {
             return new Response('Blocked by middleware', { status: 403 })
           }
           return next?.()
         }`,
      )
      project.write(
        'app/index.tsx',
        `import React from 'react'
         export default function Home() { return <h1>Page Allowed</h1> }`,
      )

      generateProject(project.root, { target: 'node' })
      const { definition } = await import(project.root + '/.build/app.ts')
      const app = await createApp(definition)
      try {
        // Blocked request returns 403
        const blockedRes = await app.fetch(new Request('http://localhost:3000/?block=true'))
        expect(blockedRes.status).toBe(403)
        expect(await blockedRes.text()).toBe('Blocked by middleware')

        // Normal request passes through and inherits middleware response headers
        const allowedRes = await app.fetch(new Request('http://localhost:3000/'))
        expect(allowedRes.status).toBe(200)
        expect(allowedRes.headers.get('x-page-middleware')).toBe('active')
        expect(await allowedRes.text()).toContain('Page Allowed')
      } finally {
        await app.close()
      }
    } finally {
      project.remove()
    }
  })

  it('renders root 404 HTML document when no page route matches HTML request', async () => {
    const project = createProject()
    try {
      project.write(
        'app/index.tsx',
        `import React from 'react'
         export default function Home() { return <h1>Home</h1> }`,
      )

      generateProject(project.root, { target: 'node' })
      const { definition } = await import(project.root + '/.build/app.ts')
      const app = await createApp(definition)
      try {
        // Request for unknown route with HTML accept header
        const req = new Request('http://localhost:3000/non-existent-page', {
          headers: { accept: 'text/html' },
        })
        const res = await app.fetch(req)
        expect(res.status).toBe(404)
        expect(res.headers.get('content-type')).toContain('text/html')
        const html = await res.text()
        expect(html).toContain('Page Not Found')
      } finally {
        await app.close()
      }
    } finally {
      project.remove()
    }
  })

  it('returns 405 Method Not Allowed for non-matching method on API route even with text/html Accept header', async () => {
    const project = createProject()
    try {
      project.write(
        'api/only.post.ts',
        `import { route } from '@olivaw/sark/server'
         export default route().handler(async () => ({ ok: true }))`,
      )
      project.write(
        'app/index.tsx',
        `import React from 'react'
         export default function Home() { return <h1>Home</h1> }`,
      )

      generateProject(project.root, { target: 'node' })
      const { definition } = await import(project.root + '/.build/app.ts')
      const app = await createApp(definition)
      try {
        const res = await app.fetch(
          new Request('http://localhost:3000/api/only', {
            method: 'GET',
            headers: { Accept: 'text/html' },
          }),
        )
        expect(res.status).toBe(405)
        expect(res.headers.get('allow')).toBe('POST')
        const body = await res.json()
        expect(body.error.code).toBe('method_not_allowed')
      } finally {
        await app.close()
      }
    } finally {
      project.remove()
    }
  })

  it('dispatches loader API calls to remote serverUrl when configured in page and forwards headers', async () => {
    const project = createProject()
    let capturedRemoteRequest: Request | undefined
    let capturedBody = ''
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init)
      if (request.url.startsWith('https://remote-api.example.com/')) {
        capturedRemoteRequest = request
        capturedBody = await request.text()
        const headers = new Headers({ 'Content-Type': 'application/json' })
        headers.append('Set-Cookie', 'session_id=new; Path=/; HttpOnly')
        headers.append('Set-Cookie', 'refresh_id=next; Path=/; HttpOnly')
        return new Response(JSON.stringify({ source: 'remote-api' }), {
          status: 200,
          headers,
        })
      }
      return originalFetch(input, init)
    }

    try {
      project.write(
        'app.ts',
        `import { definePage } from '@olivaw/sark/page'
         export const page = definePage({
           api: {
             serverUrl: 'https://remote-api.example.com',
           },
         })`,
      )
      project.write(
        'app/index.tsx',
        `import React from 'react'
         export async function loader({ client }: any) {
           const remote = await client.post('/user', { json: { name: 'Alice' } })
           return { source: remote.source }
         }
         export default function Home({ data }: any) {
           return <h1>Remote Source: {data.source}</h1>
         }`,
      )

      generateProject(project.root, { target: 'node' })
      const { definition } = await import(project.root + '/.build/app.ts')
      const app = await createApp(definition)

      try {
        const res = await app.fetch(
          new Request('http://localhost:3000/', {
            headers: {
              cookie: 'session_id=s_12345',
              authorization: 'Bearer tok_abc',
              origin: 'http://localhost:3000',
              'x-request-id': 'untrusted-client-id',
            },
          }),
        )
        expect(res.status).toBe(200)
        expect(await res.text()).toContain('remote-api')
        expect(capturedRemoteRequest?.url).toBe('https://remote-api.example.com/user')
        expect(capturedRemoteRequest?.method).toBe('POST')
        expect(capturedBody).toBe('{"name":"Alice"}')
        expect(capturedRemoteRequest?.headers.get('cookie')).toBe('session_id=s_12345')
        expect(capturedRemoteRequest?.headers.get('authorization')).toBe('Bearer tok_abc')
        expect(capturedRemoteRequest?.headers.get('origin')).toBe('http://localhost:3000')
        expect(capturedRemoteRequest?.headers.get('x-request-id')).toBe(
          res.headers.get('x-request-id'),
        )
        expect(capturedRemoteRequest?.redirect).toBe('manual')
        expect(res.headers.getSetCookie()).toEqual([
          'session_id=new; Path=/; HttpOnly',
          'refresh_id=next; Path=/; HttpOnly',
        ])
      } finally {
        await app.close()
      }
    } finally {
      globalThis.fetch = originalFetch
      project.remove()
    }
  })

  it('correctly propagates 403 Response from nested middleware through ancestor await next()', async () => {
    const project = createProject()
    try {
      project.write(
        'app/_middleware.ts',
        `export default async function rootMw(c: any, next: any) {
           await next()
         }`,
      )
      project.write(
        'app/sub/_middleware.ts',
        `export default async function subMw(c: any, next: any) {
           return new Response('Blocked by sub middleware', { status: 403 })
         }`,
      )
      project.write(
        'app/sub/index.tsx',
        `import React from 'react'
         export default function SubPage() { return <h1>Sub</h1> }`,
      )

      generateProject(project.root, { target: 'node' })
      const { definition } = await import(project.root + '/.build/app.ts')
      const app = await createApp(definition)
      try {
        const res = await app.fetch(new Request('http://localhost:3000/sub'))
        expect(res.status).toBe(403)
        expect(await res.text()).toBe('Blocked by sub middleware')
      } finally {
        await app.close()
      }
    } finally {
      project.remove()
    }
  })

  it('executes page for GET and API for POST when sharing the same path with apiPrefix="/"', async () => {
    const project = createProject()
    try {
      project.write(
        'api/posts.post.ts',
        `import { route } from '@olivaw/sark/server'
         export default route().handler(async () => ({ created: true }))`,
      )
      project.write(
        'app/posts.tsx',
        `import React from 'react'
         export default function PostsPage() { return <h1>Posts List</h1> }`,
      )

      generateProject(project.root, { target: 'node', apiPrefix: '/' })
      const { definition } = await import(project.root + '/.build/app.ts')
      const app = await createApp(definition)
      try {
        // GET /posts matches the page, not 405
        const getRes = await app.fetch(new Request('http://localhost:3000/posts'))
        expect(getRes.status).toBe(200)
        expect(await getRes.text()).toContain('Posts List')

        // POST /posts matches the API
        const postRes = await app.fetch(
          new Request('http://localhost:3000/posts', {
            method: 'POST',
            headers: { origin: 'http://localhost:3000' },
          }),
        )
        expect(postRes.status).toBe(200)
        const postBody = await postRes.json()
        expect(postBody.created).toBe(true)

        // DELETE /posts returns 405 listing the API method and the page's GET/HEAD methods.
        const deleteRes = await app.fetch(
          new Request('http://localhost:3000/posts', {
            method: 'DELETE',
            headers: { origin: 'http://localhost:3000' },
          }),
        )
        expect(deleteRes.status).toBe(405)
        expect(deleteRes.headers.get('allow')).toBe('GET, HEAD, POST')
      } finally {
        await app.close()
      }
    } finally {
      project.remove()
    }
  })
})
