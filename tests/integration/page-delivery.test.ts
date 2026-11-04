import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFileSync, renameSync, unlinkSync } from 'node:fs'
import { createServer as createSocket } from 'node:net'
import { join } from 'node:path'

import { createServer, preview } from 'vite'
import { expect, it } from 'vitest'

import { assertBrowserModules } from '../helpers/browser-modules'
import { createPageProject } from '../helpers/page-project'
import { runProjectCli, serverUrl } from '../helpers/project'

async function assertPage(origin: string, production: boolean) {
  const response = await fetch(origin + '/site/posts/1', { headers: { Accept: 'text/html' } })
  const html = await response.text()
  expect(response.status, html).toBe(200)
  expect(html).toContain('<h1>Post 1</h1>')
  expect(html).toContain('<title>Post 1</title>')
  expect(response.headers.get('X-Business')).toBe('executed')
  const bootstrap = JSON.parse(
    html.match(/<script id="__PAGE_CONTEXT__" type="application\/json">(.*?)<\/script>/s)![1],
  )
  expect(bootstrap.build.api).toEqual({ browserUrl: '/service/v2', credentials: 'same-origin' })
  expect(bootstrap.request.scopes['page:posts/[id]']).toEqual({
    status: 'success',
    data: { title: 'Post 1' },
  })
  const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((match) => match[1])
  const styles = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)].map(
    (match) => match[1],
  )
  expect(scripts.length).toBeGreaterThan(0)
  expect(styles.length).toBeGreaterThan(0)
  await assertBrowserModules(new URL(scripts[0], origin))
  for (const path of [...scripts, ...styles]) {
    expect(path).toMatch(/^\/resources\//)
    if (production) expect(path).not.toMatch(/@fs|\.build|_sark/)
    const asset = await fetch(new URL(path.replaceAll('&amp;', '&'), origin))
    const body = await asset.text()
    expect(asset.status, path + '\n' + body).toBe(200)
    expect(body).not.toMatch(/<!DOCTYPE html>/i)
    if (styles.includes(path)) {
      for (const match of body.matchAll(/url\(["']?([^"')]+)["']?\)/g)) {
        const image = await fetch(new URL(match[1], new URL(path, origin)))
        expect(image.status, match[1]).toBe(200)
        expect(image.headers.get('content-type')).toContain('image/svg+xml')
        expect(await image.text()).toContain('<svg')
      }
    }
    expect(asset.headers.get('content-type')).toMatch(
      styles.includes(path) ? /text\/css/ : /javascript/,
    )
    if (production) {
      expect(asset.headers.get('cache-control')).toContain('immutable')
      expect(asset.headers.get('X-Business')).toBeNull()
    }
  }
  expect((await fetch(origin + '/service/v2/posts/2')).status).toBe(200)
  for (const [file, contents] of [
    ['read me#.txt', 'public resource'],
    ['question?.txt', 'question resource'],
    ['percent%.txt', 'percent resource'],
    ['help.html', '<h1>Static help</h1>'],
  ]) {
    const resource = await fetch(origin + '/resources/' + encodeURIComponent(file))
    const body = await resource.text()
    expect(resource.status, file + '\n' + body).toBe(200)
    expect(body, file).toBe(contents)
    expect(resource.headers.get('X-Business'), file).toBeNull()
  }
  expect((await fetch(origin + '/resources/constructor')).status).toBe(404)
  for (const path of ['/service/v2/missing', '/outside', '/site-other']) {
    const missing = await fetch(origin + path, { headers: { Accept: 'text/html' } })
    expect(missing.status, path).toBe(404)
    expect(missing.headers.get('content-type'), path).toContain('application/json')
    expect((await missing.json()).error.code, path).toBe('not_found')
  }
  expect((await fetch(origin + '/site/missing', { headers: { Accept: 'text/html' } })).status).toBe(
    404,
  )
}

for (const target of ['node', 'cloudflare'] as const) {
  it(`delivers real SSR, module entries and route CSS in ${target} development`, async () => {
    const project = createPageProject(target)
    if (target === 'node')
      project.write(
        'app.ts',
        `import { defineApp } from '@olivaw/sark'
export const app = defineApp(() => ({ csrf: false, headers: { 'X-Instance': crypto.randomUUID() }, middleware: [async (ctx, next) => { await next(); ctx.header('X-Business', 'executed') }] }))`,
      )
    let server: Awaited<ReturnType<typeof createServer>> | undefined
    try {
      server = await createServer({
        root: project.root,
        logLevel: 'silent',
        server: { host: '127.0.0.1', port: 0 },
      })
      await server.listen()
      const origin = serverUrl(server.httpServer)
      const firstAsset = await fetch(origin + '/resources/read%20me%23.txt')
      expect(firstAsset.status, await firstAsset.text()).toBe(200)
      if (target === 'node') expect(firstAsset.headers.get('X-Instance')).toBeTruthy()
      else expect(firstAsset.headers.get('X-Application')).toBeNull()
      await assertPage(origin, false)
      const page = () => fetch(origin + '/site/posts/1', { headers: { Accept: 'text/html' } })
      const instanceId = (await page()).headers.get('X-Instance')
      const source = readFileSync(join(project.root, 'app/posts/[id].tsx'), 'utf8')
      project.write(
        'app/posts/[id].tsx',
        source.replace('<h1>{data.title}</h1>', '<h1>{data.title}</h1><h2>Updated page</h2>'),
      )
      await expect.poll(async () => await (await page()).text()).toContain('Updated page')
      if (target === 'node') expect((await page()).headers.get('X-Instance')).toBe(instanceId)
      project.write(
        'app/added.tsx',
        'export default function Added() { return <h1>Added page</h1> }',
      )
      const added = () => fetch(origin + '/site/added', { headers: { Accept: 'text/html' } })
      await expect.poll(async () => await (await added()).text()).toContain('<h1>Added page</h1>')
      unlinkSync(join(project.root, 'app/added.tsx'))
      await expect.poll(async () => (await added()).status).toBe(404)
    } finally {
      try {
        await server?.close()
      } finally {
        project.remove()
      }
    }
  }, 45000)

  it(`delivers production pages and resources through the ${target} host`, async () => {
    const project = createPageProject(target)
    try {
      const result = runProjectCli(project.root, ['build'], { NODE_ENV: 'production' })
      expect(result.status, result.stdout + result.stderr).toBe(0)
      let origin: string
      let close: () => Promise<void>
      if (target === 'cloudflare') {
        const server = await preview({
          root: project.root,
          logLevel: 'silent',
          preview: { host: '127.0.0.1', port: 0 },
        })
        origin = serverUrl(server.httpServer)
        close = () => server.close()
      } else {
        const socket = createSocket()
        await new Promise<void>((ready) => socket.listen(0, '127.0.0.1', ready))
        const address = socket.address()
        if (!address || typeof address === 'string') throw new Error('Missing port')
        const port = address.port
        await new Promise<void>((resolve) => socket.close(() => resolve()))
        const child = spawn(process.execPath, [join(project.root, 'dist/server.mjs')], {
          cwd: project.root,
          env: { ...process.env, PORT: String(port), NODE_ENV: 'production' },
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        let diagnostics = ''
        child.stderr.on('data', (data) => {
          diagnostics += data
        })
        child.stdout.on('data', (data) => {
          diagnostics += data
        })
        const exited = once(child, 'exit')
        origin = `http://127.0.0.1:${port}`
        close = async () => {
          child.kill('SIGTERM')
          await exited
        }
        await expect
          .poll(async () => {
            if (child.exitCode !== null) throw new Error(diagnostics)
            try {
              return (await fetch(origin + '/service/v2/posts/1')).status
            } catch {
              return 0
            }
          })
          .toBe(200)
        expect(readFileSync(join(project.root, 'dist/manifest.json'), 'utf8')).toContain(
          '.build/client.tsx',
        )
      }
      try {
        await assertPage(origin, true)
        const resource = await fetch(origin + '/resources/read%20me%23.txt', {
          headers: { Origin: 'https://consumer.test' },
        })
        expect(resource.status).toBe(200)
        expect(await resource.text()).toBe('public resource')
        expect(resource.headers.get('cache-control')).toBe(
          target === 'node' ? 'no-cache' : 'public, max-age=0, must-revalidate',
        )
        expect(resource.headers.get('access-control-allow-origin')).toBe(
          target === 'node' ? 'https://consumer.test' : null,
        )
        expect(resource.headers.get('X-Business')).toBeNull()
        const etag = resource.headers.get('etag')!
        expect(etag).toBeTruthy()
        expect(
          (
            await fetch(origin + '/resources/read%20me%23.txt', {
              headers: { 'If-None-Match': etag },
            })
          ).status,
        ).toBe(304)
      } finally {
        await close()
      }
    } finally {
      project.remove()
    }
  }, 45000)
}

it('uses webDir and webPrefix while keeping Vite resources reachable with the root API prefix', async () => {
  const project = createPageProject('node')
  renameSync(join(project.root, 'app'), join(project.root, 'website'))
  project.write(
    'vite.config.mts',
    readFileSync(join(project.root, 'vite.config.mts'), 'utf8').replace(
      "apiPrefix: '/service/v2'",
      "webDir: 'website', apiPrefix: '/'",
    ),
  )
  project.write(
    'website/file[.]name.tsx',
    'export default function Page() { return <h1>Literal dot page</h1> }',
  )
  const server = await createServer({
    root: project.root,
    logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0 },
  })
  try {
    await server.listen()
    const origin = serverUrl(server.httpServer)
    const response = await fetch(origin + '/site/file.name', { headers: { Accept: 'text/html' } })
    const html = await response.text()
    expect(response.status, html).toBe(200)
    expect(html).toContain('<h1>Literal dot page</h1>')
    const script = html.match(/<script[^>]+src="([^"]+)"/)![1]
    await assertBrowserModules(new URL(script, origin))
    expect(await (await fetch(origin + '/resources/help.html')).text()).toBe('<h1>Static help</h1>')
    expect((await fetch(origin + '/posts/1')).status).toBe(200)
  } finally {
    await server.close()
    project.remove()
  }
}, 45000)

it.each([
  ["import { readFileSync } from 'node:fs'", 'readFileSync.toString()', 'node:fs'],
  ["import { defineApp } from '@olivaw/sark'", 'defineApp.toString()', '@olivaw/sark'],
  ["import { app } from '../app'", 'String(app)', 'app.ts'],
])(
  'rejects a server dependency from the browser page graph: %s',
  (dependency, expression, diagnostic) => {
    const project = createPageProject('node')
    try {
      project.write(
        'app/index.tsx',
        `${dependency}\nexport default function Page() { return <p>{${expression}}</p> }`,
      )
      const result = runProjectCli(project.root, ['build'], { NODE_ENV: 'production' })
      expect(result.status).not.toBe(0)
      expect(result.stdout + result.stderr).toContain(diagnostic)
      expect(result.stdout + result.stderr).toContain(
        diagnostic === 'app.ts' ? join(project.root, 'app.ts') : 'app/index.tsx',
      )
    } finally {
      project.remove()
    }
  },
  45000,
)

it('serves native Worker assets without executing application configuration, including conditional reads', async () => {
  const project = createPageProject('cloudflare')
  project.write(
    'app.ts',
    `import { defineApp } from '@olivaw/sark'
let requests = 0
export const app = defineApp(() => ({ headers: { 'X-Worker-Requests': String(++requests) } }))`,
  )
  project.write('files/assets/names.txt', 'unhashed public data')
  let server: Awaited<ReturnType<typeof preview>> | undefined
  try {
    const result = runProjectCli(project.root, ['build'], { NODE_ENV: 'production' })
    expect(result.status, result.stdout + result.stderr).toBe(0)
    const metadata = readFileSync(join(project.root, '.build/build-assets.ts'), 'utf8')
    expect(metadata).not.toContain('"files"')
    expect(metadata).not.toContain('names.txt')
    server = await preview({
      root: project.root,
      logLevel: 'silent',
      preview: { host: '127.0.0.1', port: 0 },
    })
    const origin = serverUrl(server.httpServer)
    const first = await fetch(origin + '/resources/read%20me%23.txt')
    expect(first.status).toBe(200)
    expect(await first.text()).toBe('public resource')
    expect(first.headers.get('X-Request-Id')).toBeNull()
    expect(first.headers.get('X-Worker-Requests')).toBeNull()
    expect(first.headers.get('X-Content-Type-Options')).toBe('nosniff')
    const initial = await fetch(origin + '/service/v2/posts/1')
    expect(initial.headers.get('X-Worker-Requests')).toBe('1')
    await initial.text()
    const conditional = await fetch(origin + '/resources/read%20me%23.txt', {
      headers: { 'If-None-Match': first.headers.get('etag')! },
    })
    expect(conditional.status).toBe(304)
    const head = await fetch(origin + '/resources/read%20me%23.txt', { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
    const plain = await fetch(origin + '/resources/assets/names.txt')
    expect(await plain.text()).toBe('unhashed public data')
    expect(plain.headers.get('cache-control')).not.toContain('immutable')
    const next = await fetch(origin + '/service/v2/posts/2')
    expect(next.headers.get('X-Worker-Requests')).toBe('2')
    await next.text()
  } finally {
    try {
      await server?.close()
    } finally {
      project.remove()
    }
  }
}, 45000)

it('keeps native static files available when the Worker application configuration fails', async () => {
  const project = createPageProject('cloudflare')
  project.write(
    'app.ts',
    `import { defineApp } from '@olivaw/sark'
export const app = defineApp(() => { throw new Error('Missing application secret') })`,
  )
  let server: Awaited<ReturnType<typeof preview>> | undefined
  try {
    const result = runProjectCli(project.root, ['build'], { NODE_ENV: 'production' })
    expect(result.status, result.stdout + result.stderr).toBe(0)
    server = await preview({
      root: project.root,
      logLevel: 'silent',
      preview: { host: '127.0.0.1', port: 0 },
    })
    const origin = serverUrl(server.httpServer)
    const api = await fetch(origin + '/service/v2/posts/1')
    expect(api.status).toBe(500)
    await api.text()
    const resource = await fetch(origin + '/resources/help.html')
    expect(resource.status).toBe(200)
    expect(await resource.text()).toBe('<h1>Static help</h1>')
  } finally {
    try {
      await server?.close()
    } finally {
      project.remove()
    }
  }
}, 45000)

it('uses application-owned native headers without merging framework defaults', async () => {
  const project = createPageProject('cloudflare')
  project.write(
    'files/_headers',
    `/resources/*
  X-Static-Owner: application
  Access-Control-Allow-Origin: https://consumer.test
`,
  )
  let server: Awaited<ReturnType<typeof preview>> | undefined
  try {
    const result = runProjectCli(project.root, ['build'], { NODE_ENV: 'production' })
    expect(result.status, result.stdout + result.stderr).toBe(0)
    server = await preview({
      root: project.root,
      logLevel: 'silent',
      preview: { host: '127.0.0.1', port: 0 },
    })
    const origin = serverUrl(server.httpServer)
    const resource = await fetch(origin + '/resources/help.html', {
      headers: { Origin: 'https://consumer.test' },
    })
    expect(resource.status).toBe(200)
    expect(await resource.text()).toBe('<h1>Static help</h1>')
    expect(resource.headers.get('X-Static-Owner')).toBe('application')
    expect(resource.headers.get('Access-Control-Allow-Origin')).toBe('https://consumer.test')
    expect(resource.headers.get('X-Application')).toBeNull()
    const controlFile = await fetch(origin + '/resources/_headers')
    expect(controlFile.status).toBe(404)
    await controlFile.text()
  } finally {
    try {
      await server?.close()
    } finally {
      project.remove()
    }
  }
}, 45000)

it('uses native asset-first routing at the origin root without a page build or ASSETS binding', async () => {
  const project = createPageProject('cloudflare')
  project.write(
    'vite.config.mts',
    readFileSync(join(project.root, 'vite.config.mts'), 'utf8')
      .replace("base: '/resources'", "base: '/'")
      .replace("webPrefix: '/site'", 'webDir: false'),
  )
  project.write(
    'wrangler.jsonc',
    JSON.stringify({
      name: 'native-static-root',
      main: '.build/worker.ts',
      compatibility_date: '2026-10-01',
      compatibility_flags: ['nodejs_compat'],
      assets: { html_handling: 'none' },
    }),
  )
  project.write(
    'app.ts',
    `import { defineApp } from '@olivaw/sark'
let requests = 0
export const app = defineApp(() => ({ headers: { 'X-Worker-Requests': String(++requests) } }))`,
  )
  let server: Awaited<ReturnType<typeof preview>> | undefined
  try {
    const result = runProjectCli(project.root, ['build'], { NODE_ENV: 'production' })
    expect(result.status, result.stdout + result.stderr).toBe(0)
    server = await preview({
      root: project.root,
      logLevel: 'silent',
      preview: { host: '127.0.0.1', port: 0 },
    })
    const origin = serverUrl(server.httpServer)
    const resource = await fetch(origin + '/read%20me%23.txt')
    expect(resource.status).toBe(200)
    expect(await resource.text()).toBe('public resource')
    expect(resource.headers.get('X-Worker-Requests')).toBeNull()
    expect(resource.headers.get('X-Content-Type-Options')).toBe('nosniff')
    const api = await fetch(origin + '/service/v2/posts/1')
    expect(api.headers.get('X-Worker-Requests')).toBe('1')
    expect(await api.json()).toEqual({ title: 'Post 1' })
  } finally {
    try {
      await server?.close()
    } finally {
      project.remove()
    }
  }
}, 45000)
