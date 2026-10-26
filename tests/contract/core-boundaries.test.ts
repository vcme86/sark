import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'

import { createDefinition } from '@olivaw/sark/runtime/core'
import { createApp, defineApp, route, z } from '@olivaw/sark/server'
import { HTTPException } from 'hono/http-exception'
import { createServer } from 'vite'
import { expect, it, vi } from 'vitest'

import { generateProject } from '../../src/tooling/vite'
import { createClient } from '../../src/web/http/client/client'
import { parseApiFilePath } from '../../src/web/http/path'
import { type NavigationHost, PageController } from '../../src/web/page/browser/controller'
import { mergeMetaDescriptors } from '../../src/web/page/meta'
import { createProject, serverUrl, viteEntry } from '../helpers/project'

it('loads development server environment files from the resolved Vite envDir', async () => {
  const project = createProject()
  const key = 'SARK_COMPARE_' + crypto.randomUUID().replaceAll('-', '')
  project.write('config/.env.development', `${key}=local-value`)
  project.write(
    'app.ts',
    `import { defineApp } from '@olivaw/sark/server'
export const app = defineApp(env => {
  if (typeof env[${JSON.stringify(key)}] !== 'string') throw new Error('development value missing')
  return { headers: { 'X-Environment': env[${JSON.stringify(key)}] } }
})`,
  )
  project.write(
    'api/ping.get.ts',
    "import { route } from '@olivaw/sark/server'; export default route().handler(() => ({ ok: true }))",
  )
  project.write(
    'vite.config.mts',
    `import { sark } from ${JSON.stringify(viteEntry)}
export default { envDir: 'config', cacheDir: '.build/vite-cache', plugins: [sark({ webDir: false })] }`,
  )
  const server = await createServer({
    root: project.root,
    mode: 'development',
    logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0 },
  })
  try {
    await server.listen()
    const response = await fetch(serverUrl(server.httpServer) + '/api/ping')
    expect(response.status, await response.text()).toBe(200)
    expect(response.headers.get('X-Environment')).toBe('local-value')
    expect(process.env[key]).toBeUndefined()
    await server.watcher.unwatch(join(project.root, 'config/.env.development'))
    project.write('config/.env.development', `${key}=changed-value`)
    await server.restart()
    const updated = await fetch(serverUrl(server.httpServer) + '/api/ping')
    expect(updated.status, await updated.text()).toBe(200)
    expect(updated.headers.get('X-Environment')).toBe('changed-value')
  } finally {
    await server.close()
    delete process.env[key]
    project.remove()
  }
})

it('uses the trusted public origin for page data and browser bootstrap behind a TLS proxy', async () => {
  const project = createProject()
  project.write(
    'app.ts',
    "import { defineApp } from '@olivaw/sark/server'; export const app = defineApp({ trustedProxies: ['loopback'] })",
  )
  project.write(
    'app/index.tsx',
    'export function loader({ url }) { return { origin: url.origin } }; export default function Page() { return <p>Home</p> }',
  )
  generateProject(project.root)
  const { definition } = await import(project.root + '/.build/app.ts')
  const instance = await createApp(definition)
  try {
    const response = await instance.fetch(
      new Request('http://internal.test/', {
        headers: { 'X-Forwarded-Host': 'site.example', 'X-Forwarded-Proto': 'https' },
      }),
      { incoming: { socket: { remoteAddress: '127.0.0.1' } } },
    )
    const html = await response.text()
    expect(response.status, html).toBe(200)
    const payload = JSON.parse(
      html.match(/<script id="__PAGE_CONTEXT__" type="application\/json">(.*?)<\/script>/s)![1],
    )
    expect({ url: payload.request.url, data: payload.request.scopes['page:'].data }).toEqual({
      url: 'https://site.example/',
      data: { origin: 'https://site.example' },
    })
    expect(payload.policy).toEqual({ caseSensitive: false, trailingSlash: 'never' })
    expect(payload.build.api).toEqual({ browserUrl: '/api', credentials: 'same-origin' })
  } finally {
    await instance.close()
    project.remove()
  }
})

it('uses the same canonical website address for SSR and client navigation', async () => {
  const project = createProject()
  project.write('app.ts', '')
  project.write('app/posts/[id].tsx', 'export default function Page() { return <p>Post</p> }')
  generateProject(project.root)
  const { definition } = await import(project.root + '/.build/app.ts')
  const instance = await createApp(definition)
  try {
    const response = await instance.fetch(new Request('https://site.example/POSTS/2/'))
    expect(response.status).toBe(308)
    const host: NavigationHost = {
      commit: vi.fn(async () => {}),
      restore: vi.fn(async () => {}),
      hardNavigate: vi.fn(),
      report: vi.fn(),
    }
    const controller = new PageController(
      [
        {
          pattern: '/posts/:id',
          shapeKey: '/posts/:',
          paramNames: ['id'],
          scopes: [{ id: 'post', component: () => null }],
        },
      ],
      createClient(),
      host,
      {},
      {
        url: 'https://site.example/posts/1',
        params: { id: '1' },
        identity: { user: null },
        scopes: { post: { status: 'success' } },
      },
      { caseSensitive: false, trailingSlash: 'never' },
    )
    expect(await controller.navigate('/POSTS/2/')).toEqual({ committed: true })
    expect(controller.getSnapshot().view.url.href).toBe(response.headers.get('location'))
  } finally {
    await instance.close()
    project.remove()
  }
})

it('orders API and website routes by their complete mounted paths', async () => {
  const project = createProject()
  project.write('app.ts', '')
  project.write(
    'api/[id]/edit.get.ts',
    "import { route } from '@olivaw/sark/server'; export default route().handler(() => ({ selected: 'specific-api' }))",
  )
  project.write(
    'app/site/[section]/[id].tsx',
    'export default function Page() { return <p>Generic website route</p> }',
  )
  generateProject(project.root, { apiPrefix: '/site' })
  const { definition } = await import(project.root + '/.build/app.ts')
  const instance = await createApp(definition)
  try {
    const response = await instance.fetch(
      new Request('https://site.example/site/42/edit', { headers: { Accept: 'application/json' } }),
    )
    expect(response.headers.get('content-type'), await response.text()).toContain(
      'application/json',
    )
  } finally {
    await instance.close()
    project.remove()
  }
})

it('serves ordinary non-ASCII static route segments through API and website routing', async () => {
  const project = createProject()
  project.write('app.ts', '')
  project.write(
    'api/你好.get.ts',
    "import { route } from '@olivaw/sark/server'; export default route().handler(() => ({ greeting: true }))",
  )
  project.write('app/文章.tsx', 'export default function Page() { return <h1>文章</h1> }')
  project.write(
    'app/文章/[id].tsx',
    'export function loader({ params }) { return params.id }; export default function Page() { return <h1>文章</h1> }',
  )
  generateProject(project.root)
  const { definition } = await import(project.root + '/.build/app.ts')
  const instance = await createApp(definition)
  try {
    const api = await instance.fetch(new Request('https://site.example/api/你好'))
    const page = await instance.fetch(new Request('https://site.example/文章'))
    expect({ api: api.status, page: page.status }).toEqual({ api: 200, page: 200 })
    await api.text()
    await page.text()
    for (const id of ['a/b', '100%2F', '你好', '0%']) {
      const response = await instance.fetch(
        new Request(`https://site.example/文章/${encodeURIComponent(id)}`),
      )
      const html = await response.text()
      expect(response.status, html).toBe(200)
      const payload = JSON.parse(
        html.match(/<script id="__PAGE_CONTEXT__" type="application\/json">(.*?)<\/script>/s)![1],
      )
      expect(payload.request.params.id).toBe(id)
    }
  } finally {
    await instance.close()
    project.remove()
  }
})

it('preserves native Hono protocol errors without converting them to internal server failures', async () => {
  const instance = await createApp(
    createDefinition({
      routes: [
        {
          routePath: parseApiFilePath('private.get.ts', '/api')!,
          declaration: route().handler(() => {
            throw new HTTPException(401, {
              res: new Response('Sign in', {
                status: 401,
                headers: { 'WWW-Authenticate': 'Bearer', 'X-Auth': 'required' },
              }),
            })
          }),
        },
      ],
    }),
  )
  try {
    const response = await instance.fetch(new Request('https://site.example/api/private'))
    expect(response.status).toBe(401)
    expect(response.headers.get('WWW-Authenticate')).toBe('Bearer')
    expect(response.headers.get('X-Auth')).toBe('required')
    expect(await response.text()).toBe('Sign in')
  } finally {
    await instance.close()
  }
})

it('rejects unsupported schemas at declaration time and reuses the prepared schema interface', async () => {
  // @ts-expect-error A factory is not a schema, including when called from JavaScript.
  expect(() => route().validate({ json: z.string })).toThrow(/Route schema/)
  let selections = 0
  const schema = {
    get '~standard'() {
      selections++
      return { version: 1 as const, vendor: 'sark-test', validate: (value: unknown) => ({ value }) }
    },
  }
  const instance = await createApp(
    createDefinition({
      app: defineApp({ csrf: false }),
      routes: [
        {
          routePath: parseApiFilePath('echo.post.ts', '/api')!,
          declaration: route()
            .validate({ text: schema })
            .handler((_ctx, input) => input.text),
        },
      ],
    }),
  )
  try {
    for (const text of ['first', 'second']) {
      const response = await instance.fetch(
        new Request('https://site.example/api/echo', { method: 'POST', body: text }),
      )
      expect(await response.json()).toBe(text)
    }
    expect(selections).toBe(1)
  } finally {
    await instance.close()
  }
})

it('rejects oversized declared lengths early and limits unknown-length bodies as read', async () => {
  let calls = 0
  const instance = await createApp(
    createDefinition({
      app: defineApp({ csrf: false, bodyLimit: 4 }),
      routes: [
        {
          routePath: parseApiFilePath('echo.post.ts', '/api')!,
          declaration: route({
            middleware: [
              async (_ctx, next) => {
                calls++
                await next()
              },
            ],
          }).handler(async (ctx) => ctx.req.text()),
        },
      ],
    }),
  )
  try {
    for (const contentType of [
      'application/json',
      'text/plain',
      'application/x-www-form-urlencoded',
    ]) {
      for (const body of ['1234', '12345']) {
        const response = await instance.fetch(
          new Request('https://site.example/api/echo', {
            method: 'POST',
            body,
            headers: { 'Content-Type': contentType, 'Content-Length': String(body.length) },
          }),
        )
        expect(response.status).toBe(body.length <= 4 ? 200 : 413)
        await response.text()
      }
    }
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(5))
      },
      cancel() {
        cancelled = true
      },
    })
    const response = await instance.fetch(
      new Request('https://site.example/api/echo', {
        method: 'POST',
        body,
        duplex: 'half',
      } as RequestInit),
    )
    expect(response.status).toBe(413)
    await response.text()
    expect(cancelled).toBe(true)
    expect(calls).toBe(4)
  } finally {
    await instance.close()
  }
})

it('allows child metadata to replace the same explicit link key and singleton rel', () => {
  const meta = mergeMetaDescriptors([
    {
      links: [
        { key: 'icon', rel: 'icon', href: '/parent.ico' },
        { rel: 'manifest', href: '/parent.webmanifest' },
      ],
    },
    {
      links: [
        { key: 'icon', rel: 'icon', href: '/child.ico' },
        { rel: 'manifest', href: '/child.webmanifest' },
      ],
    },
  ])
  expect(meta.links).toEqual([
    { key: 'icon', rel: 'icon', href: '/child.ico' },
    { rel: 'manifest', href: '/child.webmanifest' },
  ])
})

it('rejects common route declaration mistakes during the unchanged project type check', () => {
  const project = createProject()
  project.write(
    'contracts.ts',
    `import { route, z } from '@olivaw/sark/server'
// @ts-expect-error A schema factory is not a validation schema.
route().validate({ json: z.string }).handler(() => null)
// @ts-expect-error Unknown route option.
route({ cros: false }).handler(() => null)
`,
  )
  project.write(
    'tsconfig.json',
    JSON.stringify({ extends: resolve('tsconfig.json'), include: ['contracts.ts'] }),
  )
  try {
    const pnpm = process.env.npm_execpath!
    const isScript = /\.(?:c|m)?js$/i.test(pnpm)
    const args = ['typecheck', '--project', join(project.root, 'tsconfig.json')]
    const result = spawnSync(
      isScript ? process.execPath : pnpm,
      isScript ? [pnpm, ...args] : args,
      { encoding: 'utf8', cwd: process.cwd() },
    )
    if (result.error) throw result.error
    expect(result.status, result.stdout + result.stderr).toBe(0)
  } finally {
    project.remove()
  }
})
