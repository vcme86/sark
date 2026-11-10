import { join } from 'node:path'

import { createServer } from 'vite'
import { expect, it, vi } from 'vitest'

import { createClient } from '../../src/client/client'
import { createApp } from '../../src/entries/root'
import { type NavigationHost, PageController } from '../../src/page/browser/controller'
import { generateProject } from '../../src/tooling/build/project'
import { createProject, serverUrl, viteEntry } from '../helpers/project'

it('loads development server environment files from the resolved Vite envDir', async () => {
  const project = createProject()
  const key = 'SARK_COMPARE_' + crypto.randomUUID().replaceAll('-', '')
  project.write('config/.env.development', `${key}=local-value`)
  project.write(
    'app.ts',
    `import { defineApp } from '@olivaw/sark'
export const app = defineApp(env => {
  if (typeof env[${JSON.stringify(key)}] !== 'string') throw new Error('development value missing')
  return { headers: { 'X-Environment': env[${JSON.stringify(key)}] } }
})`,
  )
  project.write(
    'api/ping.get.ts',
    "import { route } from '@olivaw/sark'; export default route().handler(() => ({ ok: true }))",
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
    "import { defineApp } from '@olivaw/sark'; export const app = defineApp({ trustedProxies: ['loopback'] })",
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
    expect(payload).toEqual({
      request: {
        scopes: { 'page:': { status: 'success', data: { origin: 'https://site.example' } } },
      },
    })
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
    const route = {
      pattern: '/posts/:id',
      shapeKey: '/posts/:',
      paramNames: ['id'],
      scopes: [{ id: 'post', component: () => null }],
    }
    const controller = new PageController(
      [route],
      createClient(),
      host,
      {
        route,
        url: new URL('https://site.example/posts/1'),
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
    "import { route } from '@olivaw/sark'; export default route().handler(() => ({ selected: 'specific-api' }))",
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
    "import { route } from '@olivaw/sark'; export default route().handler(() => ({ greeting: true }))",
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
      expect(payload.request.scopes['page:文章/[id]'].data).toBe(id)
    }
  } finally {
    await instance.close()
    project.remove()
  }
})
