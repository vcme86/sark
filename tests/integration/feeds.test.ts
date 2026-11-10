import { type ChildProcess, spawn } from 'node:child_process'
import { once } from 'node:events'
import { join, relative } from 'node:path'

import * as Feedsmith from 'feedsmith'
import { createServer, preview, type PreviewServer, type ViteDevServer } from 'vite'
import { expect, it } from 'vitest'

import { createProject, projectRoot, runProjectCli, serverUrl } from '../helpers/project'
import { checkGeneratedTypes } from '../helpers/typecheck'

function createFeedProject(target: 'node' | 'cloudflare') {
  const project = createProject()
  const fixtures = relative(project.root, join(projectRoot, 'tests/helpers/feeds')).replaceAll(
    '\\',
    '/',
  )
  project.write(
    'app.ts',
    `import { defineApp } from '@olivaw/sark'
import { defineFeeds } from '@olivaw/sark/feeds'
import { rssData, atomData, jsonData, opmlData } from ${JSON.stringify(fixtures)}
${target === 'node' ? "import { defineNodeRuntime } from '@olivaw/sark/node'\nexport const runtime = defineNodeRuntime({ port: 0, hostname: '127.0.0.1', probes: false })" : ''}
export const app = defineApp({ middleware: [async (ctx, next) => {
  await next(); ctx.header('X-Application', 'feeds')
}] })
export const feeds = defineFeeds((env: { PUBLIC_ORIGIN: string }) => ({
  rss: { format: 'rss', load: rssData },
  articles: { format: 'atom', async load(ctx) {
    await Promise.resolve()
    const data = atomData()
    return { ...data, links: [{ href: env.PUBLIC_ORIGIN + '/feed.atom', rel: 'self' }],
      entries: data.entries.map(entry => ({ ...entry, title: { value: ctx.req.header('X-Article') ?? 'Article' } })),
    }
  } },
  json: { format: 'json', load: jsonData },
  subscriptions: { format: 'opml', load: opmlData },
}))`,
  )
  project.write(
    'vite.config.mts',
    `import { sark } from '@olivaw/sark/vite'
${target === 'cloudflare' ? "import { cloudflare } from '@cloudflare/vite-plugin'" : ''}
export default {
  cacheDir: '.build/vite-cache',
  plugins: [sark({ target: '${target}', apiDir: false, webDir: false })${target === 'cloudflare' ? ", cloudflare({ viteEnvironment: { name: 'ssr' }, inspectorPort: false, persistState: false, remoteBindings: false })" : ''}],
}`,
  )
  if (target === 'cloudflare') {
    project.write(
      'worker.ts',
      `import worker from './.build/worker'
export default { fetch(request, env, context) {
  return worker.fetch(request, { ...env, PUBLIC_ORIGIN: request.headers.get('X-Public-Origin') ?? env.PUBLIC_ORIGIN }, context)
} }`,
    )
    project.write(
      'wrangler.jsonc',
      JSON.stringify({
        name: 'feed-contract',
        main: 'worker.ts',
        compatibility_date: '2026-10-01',
        compatibility_flags: ['nodejs_compat'],
        vars: { PUBLIC_ORIGIN: 'https://feeds.test' },
      }),
    )
  }
  return project
}

async function checkDelivery(origin: string) {
  const rss = Feedsmith.parseRssFeed(await (await fetch(origin + '/feed.xml')).text())
  expect(rss.items?.[0].guid).toMatchObject({ value: 'urn:uuid:article-1', isPermaLink: false })
  expect(rss.items?.[0].enclosures?.[0].type).toBe('audio/mpeg')
  const response = await fetch(origin + '/feed.atom', {
    headers: { 'X-Article': 'Selected & real' },
  })
  const xml = await response.text()
  expect(response.status, xml).toBe(200)
  expect(response.headers.get('X-Application')).toBe('feeds')
  expect(response.headers.get('content-type')).toContain('application/atom+xml')
  const atom = Feedsmith.parseAtomFeed(xml)
  expect(atom.title?.value).toBe('News & Notes')
  expect(atom.entries?.[0].title?.value).toBe('Selected & real')
  expect(atom.entries?.[0].links).toContainEqual(
    expect.objectContaining({ rel: 'enclosure', type: 'audio/mpeg', length: 456 }),
  )
  expect(atom.links).toContainEqual(
    expect.objectContaining({ rel: 'self', href: 'https://feeds.test/feed.atom' }),
  )
  const json = await (await fetch(origin + '/feed.json')).json()
  expect(json.items[0].content_text).toBe('Readable content')
  const opml = Feedsmith.parseOpml(await (await fetch(origin + '/subscriptions.opml')).text())
  expect(opml.body?.outlines?.[0].xmlUrl).toBe('https://feeds.example/feed.atom')
  const head = await fetch(origin + '/feed.atom', { method: 'HEAD' })
  expect(head.status).toBe(200)
  expect(await head.text()).toBe('')
  expect((await fetch(origin + '/feed.xml', { method: 'POST' })).status).toBe(405)
}

it('serves discovered subscriptions through real Node development and production hosts', async () => {
  const project = createFeedProject('node')
  let server: ViteDevServer | undefined
  let child: ChildProcess | undefined
  let exited: Promise<unknown> | undefined
  try {
    project.write('.env', 'PUBLIC_ORIGIN=https://feeds.test')
    server = await createServer({
      root: project.root,
      logLevel: 'silent',
      server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
    })
    await server.listen()
    await checkDelivery(serverUrl(server.httpServer))
    await server.close()
    server = undefined
    const built = runProjectCli(project.root, ['build'], { NODE_ENV: 'production' })
    expect(built.status, built.stdout + built.stderr).toBe(0)
    child = spawn(process.execPath, [join(project.root, 'dist/server.mjs')], {
      cwd: project.root,
      env: { ...process.env, NODE_ENV: 'production' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    exited = once(child, 'exit')
    let output = ''
    child.stdout!.on('data', (chunk) => {
      output += chunk
    })
    child.stderr!.on('data', (chunk) => {
      output += chunk
    })
    await expect
      .poll(() => {
        if (child!.exitCode !== null) throw new Error(output)
        return /Node server listening on port (\d+)/.exec(output)?.[1]
      })
      .toBeTruthy()
    await checkDelivery(
      'http://127.0.0.1:' + /Node server listening on port (\d+)/.exec(output)![1],
    )
  } finally {
    if (child && child.exitCode === null) child.kill('SIGTERM')
    await exited
    await server?.close()
    project.remove()
  }
}, 45000)

it('generates subscriptions in real workerd with isolated event configuration', async () => {
  const project = createFeedProject('cloudflare')
  let server: PreviewServer | undefined
  try {
    const built = runProjectCli(project.root, ['build'], { NODE_ENV: 'production' })
    expect(built.status, built.stdout + built.stderr).toBe(0)
    server = await preview({
      root: project.root,
      logLevel: 'silent',
      preview: { host: '127.0.0.1', port: 0 },
    })
    const origin = serverUrl(server.httpServer)
    await checkDelivery(origin)
    const responses = await Promise.all(
      ['https://one.test', 'https://two.test'].map(async (canonical) => {
        const response = await fetch(origin + '/feed.atom', {
          headers: { 'X-Public-Origin': canonical },
        })
        const atom = Feedsmith.parseAtomFeed(await response.text())
        return atom.links?.find((link) => link.rel === 'self')?.href
      }),
    )
    expect(responses).toEqual(['https://one.test/feed.atom', 'https://two.test/feed.atom'])
  } finally {
    await server?.close()
    project.remove()
  }
}, 45000)

it('checks generated resource context and environment requirements without a public feed service', async () => {
  const result = await checkGeneratedTypes(
    {
      'app.ts': `import { defineFeeds } from '@olivaw/sark/feeds'
import { defineDatabase } from '@olivaw/sark/db/sqlite'
import { sql } from 'drizzle-orm'
export const database = defineDatabase({ filename: ':memory:' })
export const feeds = defineFeeds((env: { TITLE: string }) => ({ articles: {
  format: 'atom',
  load(ctx) {
    ctx.var.db.run(sql\`select 1\`)
    // @ts-expect-error Subscription endpoints do not bind an empty request service.
    ctx.var.feeds
    return { id: 'urn:uuid:feed', title: { value: env.TITLE }, updated: new Date(), authors: [{ name: 'Editor' }], entries: [] }
  },
} }))`,
      'host.ts': `import { createApp } from '@olivaw/sark'
import { definition } from './.build/app'
createApp(definition, { env: { TITLE: 'Site' } })
// @ts-expect-error The declaration factory requires an environment.
createApp(definition)
// @ts-expect-error The required TITLE field cannot be omitted.
createApp(definition, { env: {} })`,
    },
    { customHost: true },
  )
  expect(result.status, result.output).toBe(0)
})
