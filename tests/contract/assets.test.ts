import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createElement } from 'react'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createDefinition } from '../../src/entries/runtime/core'
import { createApp, defineApp } from '../../src/entries/server'
import { createPageConfigResolver } from '../../src/page/config'
import { createPage404Handler } from '../../src/page/server/handler'
import { defineAssets } from '../../src/services/assets/node'
import { routeEntry } from '../helpers/http-app'

describe('Node Asset Mounts Contract', () => {
  let tempRoot: string
  let uploadsDir: string
  let outsideDir: string

  beforeAll(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'sark-assets-test-'))
    uploadsDir = join(tempRoot, 'uploads')
    outsideDir = await mkdtemp(join(tmpdir(), 'sark-assets-outside-'))

    await mkdir(uploadsDir, { recursive: true })

    // Normal file
    await writeFile(join(uploadsDir, 'hello.txt'), 'Hello Assets!')
    // File with same name as an API route to test route priority
    await writeFile(join(uploadsDir, 'override-target'), 'Hello From Asset')
    // Special character file: name has literal '#' and '?'
    await writeFile(join(uploadsDir, '#hash?query%percent.txt'), 'Special Chars Content')
    // File outside uploadsDir
    await writeFile(join(outsideDir, 'secret.env'), 'SECRET_KEY=12345')

    // Symlinks inside uploadsDir
    await symlink(join(uploadsDir, 'hello.txt'), join(uploadsDir, 'link-inside.txt'))
    await symlink(join(outsideDir, 'secret.env'), join(uploadsDir, 'link-outside.txt'))
  })

  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true })
    await rm(outsideDir, { recursive: true, force: true })
  })

  it('serves files via declared asset mounts and executes global middleware first', async () => {
    let authHeaderObserved = ''

    const appDef = createDefinition({
      app: defineApp({
        middleware: [
          async (ctx, next) => {
            authHeaderObserved = ctx.req.header('x-auth-token') || ''
            if (ctx.req.header('x-forbidden') === 'true') {
              return new Response('Forbidden by middleware', { status: 403 })
            }
            return next()
          },
        ],
      }),
      assetMounts: defineAssets([
        { path: '/files', dir: uploadsDir, headers: { 'x-custom-asset': 'yes' } },
      ]),
    })

    const instance = await createApp(appDef)

    // 1. Successful GET
    const res = await instance.fetch(
      new Request('http://localhost/files/hello.txt', {
        headers: { 'x-auth-token': 'token-123' },
      }),
    )
    expect(res.status).toBe(200)
    expect(authHeaderObserved).toBe('token-123')
    expect(res.headers.get('x-custom-asset')).toBe('yes')
    expect(res.headers.get('cache-control')).toBe('no-cache')
    expect(await res.text()).toBe('Hello Assets!')

    // 2. Global middleware can reject requests to asset mounts
    const rejectedRes = await instance.fetch(
      new Request('http://localhost/files/hello.txt', {
        headers: { 'x-forbidden': 'true' },
      }),
    )
    expect(rejectedRes.status).toBe(403)
    expect(await rejectedRes.text()).toBe('Forbidden by middleware')
  })

  it('gives priority to explicit API routes over asset mounts (file route priority)', async () => {
    const appDef = createDefinition({
      app: defineApp(),
      routes: [
        routeEntry('/api/files/override-target', () => new Response('From API Route override')),
      ],
      assetMounts: defineAssets([{ path: '/api/files', dir: uploadsDir }]),
    })

    const instance = await createApp(appDef)
    const res = await instance.fetch(new Request('http://localhost/api/files/override-target'))
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('From API Route override')
  })

  it('tries subsequent directories before using the shared HTML or JSON 404 response', async () => {
    const secondary = join(tempRoot, 'secondary')
    await mkdir(secondary)
    await writeFile(join(secondary, 'fallback.txt'), 'Secondary file')
    await writeFile(join(secondary, 'hello.txt'), 'Must not replace the first mount')
    const instance = await createApp(
      createDefinition({
        apiPrefix: '/api',
        webPrefix: '/',
        createPageConfigResolver: () => createPageConfigResolver(undefined, '/api'),
        page404Handler: createPage404Handler(
          undefined,
          () => createElement('main', null, 'Site page not found'),
          () => ({ bootstrapModules: [], stylesheets: [], routeStyles: {} }),
        ),
        assetMounts: defineAssets([
          { path: '/', dir: uploadsDir },
          { path: '/', dir: secondary },
        ]),
      }),
    )
    try {
      const first = await instance.fetch(new Request('http://localhost/hello.txt'))
      expect(await first.text()).toBe('Hello Assets!')
      const fallback = await instance.fetch(new Request('http://localhost/fallback.txt'))
      expect(fallback.status).toBe(200)
      expect(await fallback.text()).toBe('Secondary file')
      for (const path of ['/', '/missing-page']) {
        const response = await instance.fetch(
          new Request(`http://localhost${path}`, {
            headers: { accept: 'text/html' },
          }),
        )
        expect(response.status).toBe(404)
        expect(response.headers.get('content-type')).toContain('text/html')
        expect(await response.text()).toContain('Site page not found')
      }
      const json = await instance.fetch(new Request('http://localhost/missing-file'))
      expect(json.status).toBe(404)
      expect(await json.json()).toMatchObject({ error: { code: 'not_found' } })
    } finally {
      await instance.close()
    }
  })

  it('serves a directory created after startup beneath a symlinked root', async () => {
    const physical = join(tempRoot, 'physical')
    const alias = join(tempRoot, 'alias')
    await mkdir(physical)
    await symlink(physical, alias, 'dir')
    const instance = await createApp(
      createDefinition({
        assetMounts: defineAssets([{ path: '/late', dir: join(alias, 'uploads') }]),
      }),
    )
    try {
      expect((await instance.fetch(new Request('http://localhost/late/ready.txt'))).status).toBe(
        404,
      )
      await mkdir(join(physical, 'uploads'))
      await writeFile(join(physical, 'uploads/ready.txt'), 'Created after startup')
      await symlink(join(physical, 'uploads/ready.txt'), join(physical, 'uploads/linked.txt'))
      const ready = await instance.fetch(new Request('http://localhost/late/ready.txt'))
      expect(ready.status).toBe(200)
      expect(await ready.text()).toBe('Created after startup')
      expect((await instance.fetch(new Request('http://localhost/late/linked.txt'))).status).toBe(
        404,
      )
    } finally {
      await instance.close()
    }
  })

  it('applies application CORS and admission policies to mounts before business middleware', async () => {
    let calls = 0
    const instance = await createApp(
      createDefinition({
        app: defineApp({
          cors: { origin: 'https://reader.example' },
          bodyLimit: 2,
          csrf: { origins: ['https://reader.example'] },
          middleware: [
            async (_context, next) => {
              calls++
              await next()
            },
          ],
        }),
        assetMounts: defineAssets([{ path: '/files', dir: uploadsDir }]),
      }),
    )
    try {
      const get = await instance.fetch(
        new Request('http://localhost/files/hello.txt', {
          headers: { origin: 'https://reader.example' },
        }),
      )
      expect(get.headers.get('access-control-allow-origin')).toBe('https://reader.example')
      await get.body?.cancel()
      expect(calls).toBe(1)
      const oversized = await instance.fetch(
        new Request('http://localhost/files/hello.txt', {
          method: 'POST',
          body: 'too large',
          headers: {
            origin: 'https://reader.example',
            'content-type': 'text/plain',
            'content-length': '9',
          },
        }),
      )
      expect(oversized.status).toBe(413)
      expect(oversized.headers.get('access-control-allow-origin')).toBe('https://reader.example')
      expect(calls).toBe(1)
    } finally {
      await instance.close()
    }
  })

  it('correctly handles encoded special characters and rejects directory traversal', async () => {
    const appDef = createDefinition({
      app: defineApp(),
      assetMounts: defineAssets([{ path: '/files', dir: uploadsDir }]),
    })
    const instance = await createApp(appDef)

    // Access literal '#hash?query%percent.txt' via proper URL encoding
    const encoded = encodeURIComponent('#hash?query%percent.txt')
    const resSpecial = await instance.fetch(new Request(`http://localhost/files/${encoded}`))
    expect(resSpecial.status).toBe(200)
    expect(await resSpecial.text()).toBe('Special Chars Content')

    // Directory traversal attempt -> 404
    const resTraversal = await instance.fetch(
      new Request('http://localhost/files/%2e%2e/%2e%2e/etc/passwd'),
    )
    expect(resTraversal.status).toBe(404)

    // Non-existent file -> 404
    const resMissing = await instance.fetch(new Request('http://localhost/files/not-found.txt'))
    expect(resMissing.status).toBe(404)

    // Directory root without file -> 404
    const resDir = await instance.fetch(new Request('http://localhost/files'))
    expect(resDir.status).toBe(404)
  })

  it('rejects non-GET/HEAD methods on asset mounts with 405 Method Not Allowed', async () => {
    const appDef = createDefinition({
      app: defineApp(),
      assetMounts: defineAssets([{ path: '/files', dir: uploadsDir }]),
    })
    const instance = await createApp(appDef)

    const postRes = await instance.fetch(
      new Request('http://localhost/files/hello.txt', {
        method: 'POST',
        headers: { origin: 'http://localhost' },
      }),
    )
    expect(postRes.status).toBe(405)
    expect(postRes.headers.get('Allow')).toBe('GET, HEAD')
  })

  it('respects symlink policy (followSymlinks defaults to false)', async () => {
    const appDef = createDefinition({
      app: defineApp(),
      assetMounts: defineAssets([
        { path: '/files-nosym', dir: uploadsDir, followSymlinks: false },
        { path: '/files-sym', dir: uploadsDir, followSymlinks: true },
      ]),
    })
    const instance = await createApp(appDef)

    // link-inside without followSymlinks -> 404
    const resNoSym = await instance.fetch(
      new Request('http://localhost/files-nosym/link-inside.txt'),
    )
    expect(resNoSym.status).toBe(404)

    // link-inside with followSymlinks -> 200
    const resSym = await instance.fetch(new Request('http://localhost/files-sym/link-inside.txt'))
    expect(resSym.status).toBe(200)

    // link-outside pointing outside root is ALWAYS rejected -> 404
    const resSymOutside = await instance.fetch(
      new Request('http://localhost/files-sym/link-outside.txt'),
    )
    expect(resSymOutside.status).toBe(404)
  })

  it('combines methods from real files and registered routes without treating missing files as resources', async () => {
    await mkdir(join(uploadsDir, 'api'))
    await writeFile(join(uploadsDir, 'api/report.csv'), 'Cached report')
    const instance = await createApp(
      createDefinition({
        app: defineApp({ csrf: false }),
        routes: [
          routeEntry('/api/upload', () => new Response('Uploaded'), 'post'),
          routeEntry('/api/:report', () => new Response('Report updated'), 'post'),
        ],
        assetMounts: defineAssets([{ path: '/', dir: uploadsDir }]),
      }),
    )
    try {
      for (const [path, method, status, allow] of [
        ['/api/upload', 'OPTIONS', 405, 'POST'],
        ['/api/report.csv', 'OPTIONS', 405, 'GET, HEAD, POST'],
        ['/hello.txt', 'POST', 405, 'GET, HEAD'],
        ['/missing-file', 'POST', 404, null],
      ] as const) {
        const response = await instance.fetch(new Request(`http://localhost${path}`, { method }))
        expect(response.status).toBe(status)
        expect(response.headers.get('allow')).toBe(allow)
        await response.body?.cancel()
      }
      const posted = await instance.fetch(
        new Request('http://localhost/api/report.csv', { method: 'POST' }),
      )
      expect(await posted.text()).toBe('Report updated')
      const retrieved = await instance.fetch(new Request('http://localhost/api/report.csv'))
      expect(await retrieved.text()).toBe('Cached report')
    } finally {
      await instance.close()
    }
  })

  it('compares opaque ETags containing commas without splitting their values', async () => {
    const instance = await createApp(
      createDefinition({
        assetMounts: defineAssets([
          { path: '/files', dir: uploadsDir, headers: { etag: '"rev,1"' } },
        ]),
      }),
    )
    try {
      for (const [headers, status] of [
        [{ 'if-match': '"other", "rev,1"' }, 200],
        [{ 'if-match': 'W/"rev,1"' }, 412],
        [{ 'if-none-match': '"other", W/"rev,1"' }, 304],
        [{ 'if-none-match': '"rev", "1"' }, 200],
      ] as const) {
        const response = await instance.fetch(
          new Request('http://localhost/files/hello.txt', { headers }),
        )
        expect(response.status).toBe(status)
        expect(await response.text()).toBe(status === 200 ? 'Hello Assets!' : '')
      }
    } finally {
      await instance.close()
    }
  })

  it('strictly enforces RFC 9110 §13.1.5: If-Range with weak ETag must be ignored and return full 200', async () => {
    const appDef = createDefinition({
      app: defineApp(),
      assetMounts: defineAssets([{ path: '/files', dir: uploadsDir }]),
    })
    const instance = await createApp(appDef)

    // 1. Initial request to obtain file's ETag and Last-Modified
    const initialRes = await instance.fetch(new Request('http://localhost/files/hello.txt'))
    expect(initialRes.status).toBe(200)
    const etag = initialRes.headers.get('etag')
    expect(etag).toMatch(/^W\//) // Weak ETag

    // 2. Request with Range and If-Range using the weak ETag
    // Per RFC 9110 §13.1.5, weak validators MUST NOT match in strong comparison.
    // The server MUST ignore Range and return 200 with the complete representation.
    const weakIfRangeRes = await instance.fetch(
      new Request('http://localhost/files/hello.txt', {
        headers: {
          Range: 'bytes=0-4',
          'If-Range': etag!,
        },
      }),
    )
    expect(weakIfRangeRes.status).toBe(200)
    expect(await weakIfRangeRes.text()).toBe('Hello Assets!')

    // 3. Request with valid matching Last-Modified HTTP-Date permits 206
    const lastModified = initialRes.headers.get('last-modified')
    const dateIfRangeRes = await instance.fetch(
      new Request('http://localhost/files/hello.txt', {
        headers: {
          Range: 'bytes=0-4',
          'If-Range': lastModified!,
        },
      }),
    )
    expect(dateIfRangeRes.status).toBe(206)
    expect(await dateIfRangeRes.text()).toBe('Hello')

    const precondition = await instance.fetch(
      new Request('http://localhost/files/hello.txt', {
        headers: { 'if-match': etag!, 'if-none-match': etag! },
      }),
    )
    expect(precondition.status).toBe(412)
    expect(await precondition.text()).toBe('')
  })
})
