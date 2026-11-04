import { join, relative } from 'node:path'

import { preview, type PreviewServer } from 'vite'
import { expect, it } from 'vitest'

import { createProject, projectRoot, runProjectCli, serverUrl } from '../helpers/project'
import { statsSchema } from '../helpers/stats-store-contracts'

it('executes D1 stats, SSR reuse, event isolation and Scheduled jobs in real workerd', async () => {
  const project = createProject()
  let server: PreviewServer | undefined
  const contracts = relative(
    project.root,
    join(projectRoot, 'tests/helpers/stats-store-contracts'),
  ).replaceAll('\\', '/')
  project.write(
    'audit.ts',
    `export const events: { event: string; action: string; token: string }[] = []`,
  )
  project.write(
    'app.ts',
    `import { defineApp } from '@olivaw/sark'
import { defineDatabase } from '@olivaw/sark/db/d1'
import { defineStats } from '@olivaw/sark/stats'
import { sqlStats } from '@olivaw/sark/stats/d1'
import { defineJobs } from '@olivaw/sark/jobs'
import type { D1Database } from '@cloudflare/workers-types'
import { events } from './audit'
export const app = defineApp({ csrf: false })
export const database = defineDatabase((env: { DB: D1Database }) => ({ binding: env.DB }))
export const stats = defineStats((env: { EVENT: string }) => ({
  counters: { views: { uniqueBy: 'subject' }, hits: { uniqueBy: false } },
  store: {
    target: 'cloudflare',
    async create(context) {
      const token = crypto.randomUUID()
      const store = await sqlStats({ database }).create(context)
      events.push({ event: env.EVENT, action: 'create', token })
      return {
        value: {
          async record(input) {
            events.push({ event: env.EVENT, action: 'record', token })
            await store.value.record(input)
          },
          read: input => store.value.read(input),
        },
        dispose() {
          events.push({ event: env.EVENT, action: 'dispose', token })
        },
      }
    },
  },
}))
export const jobs = defineJobs([{
  name: 'count',
  onCron: '* * * * *',
  async handler(context) {
    await context.stats.increment('hits', { key: 'job' })
  },
}])`,
  )
  project.write(
    'api/test.post.ts',
    `import { route, getLogger } from '@olivaw/sark'
import { sqlStats, statsCounters } from '@olivaw/sark/stats/d1'
import { database } from '../app'
import { checkStatsStore } from ${JSON.stringify('../' + contracts)}
export default route().handler(async c => {
  const input = await c.req.json()
  const binding = c.var.db.$client
  if (input.op === 'setup') {
    await binding.batch(input.statements.map((statement: string) => binding.prepare(statement)))
    return { ready: true }
  }
  if (input.op === 'contracts') {
    const store = await sqlStats({ database }).create({
      resources: { db: c.var.db },
      resourceDeclarations: { db: database },
      target: 'cloudflare',
      logger: getLogger('test'),
      signal: c.req.raw.signal,
      waitUntil: promise => c.executionCtx.waitUntil(promise),
      requirements: { unique: true },
    })
    await checkStatsStore(store.value)
    return { passed: true }
  }
  if (input.op === 'record') {
    await c.var.stats.increment('views', { key: input.key, subject: { kind: 'user', id: input.id } })
    return c.var.stats.read('views', { key: input.key })
  }
  if (input.op === 'rollback') {
    await binding.exec("CREATE TRIGGER fail_subject BEFORE INSERT ON stats_subjects WHEN NEW.id = 'reject' BEGIN SELECT RAISE(ABORT, 'subject failed'); END")
    let rejected = false
    try {
      await c.var.stats.increment('views', {
        key: 'rollback',
        subject: { kind: 'user', id: 'reject' },
      })
    } catch {
      rejected = true
    }
    return { rejected, counts: await c.var.stats.read('views', { key: 'rollback' }) }
  }
  if (input.op === 'plain') {
    await binding.exec('DROP TABLE stats_subjects')
    const plain = await sqlStats({ database, tables: { counters: statsCounters } }).create({
      resources: { db: c.var.db },
      resourceDeclarations: { db: database },
      target: 'cloudflare',
      logger: getLogger('test'),
      signal: c.req.raw.signal,
      waitUntil: promise => c.executionCtx.waitUntil(promise),
      requirements: { unique: false },
    })
    await plain.value.record({ name: 'plain', key: 'a' })
    return plain.value.read({ name: 'plain', key: 'a', unique: false })
  }
  if (input.op === 'job') return c.var.stats.read('hits', { key: 'job' })
  return c.text('Unknown test operation', 400)
})`,
  )
  project.write(
    'api/read.get.ts',
    `import { route } from '@olivaw/sark'
export default route().handler(async c => {
  await c.var.stats.increment('hits', { key: 'ssr' })
  return c.var.stats.read('hits', { key: 'ssr' })
})`,
  )
  project.write(
    'app/_root.tsx',
    `import { Head, Outlet, Scripts } from '@olivaw/sark/page'
export default function Root() { return <html><head><Head /></head><body><Outlet /><Scripts /></body></html> }`,
  )
  project.write(
    'app/counter.tsx',
    `import type { LoaderArgs } from '@olivaw/sark/page'
export async function loader({ client }: LoaderArgs) { return client.get('/read') }
export default function Page({ data }: { data: { count: number } }) { return <p>Count {data.count}</p> }`,
  )
  project.write(
    'worker.ts',
    `import worker from './.build/worker'
import { events } from './audit'
export default {
  async fetch(request, env, context) {
    const path = new URL(request.url).pathname
    if (path === '/test-audit') return Response.json(events)
    const selected = {
      ...env,
      DB: request.headers.get('x-database') === 'other' ? env.OTHER : env.DB,
      EVENT: request.headers.get('x-event') ?? path,
    }
    if (path === '/test-job') {
      await worker.scheduled(
        { cron: '* * * * *', scheduledTime: Date.now() }, selected, context,
      )
      return new Response('scheduled')
    }
    return worker.fetch(request, selected, context)
  },
}`,
  )
  project.write(
    'vite.config.mts',
    `import { sark } from '@olivaw/sark/vite'
import react from '@vitejs/plugin-react'
import { cloudflare } from '@cloudflare/vite-plugin'
export default {
  cacheDir: '.build/vite-cache',
  plugins: [
    sark({ target: 'cloudflare' }),
    react(),
    cloudflare({
      viteEnvironment: { name: 'ssr' }, inspectorPort: false,
      persistState: false, remoteBindings: false,
    }),
  ],
}`,
  )
  project.write(
    'wrangler.jsonc',
    JSON.stringify({
      name: 'stats-contract',
      main: 'worker.ts',
      compatibility_date: '2026-10-01',
      compatibility_flags: ['nodejs_compat'],
      d1_databases: [
        { binding: 'DB', database_name: 'stats-contract', database_id: 'stats-primary' },
        { binding: 'OTHER', database_name: 'stats-other', database_id: 'stats-secondary' },
      ],
      triggers: { crons: ['* * * * *'] },
    }),
  )
  try {
    const built = runProjectCli(project.root, ['build'], { NODE_ENV: 'production' })
    expect(built.status, built.stdout + built.stderr).toBe(0)
    server = await preview({
      root: project.root,
      logLevel: 'silent',
      preview: { host: '127.0.0.1', port: 0 },
    })
    const origin = serverUrl(server.httpServer)
    const call = async (body: unknown, other = false) => {
      const response = await fetch(`${origin}/api/test`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(other ? { 'x-database': 'other' } : {}),
        },
        body: JSON.stringify(body),
      })
      const text = await response.text()
      expect(response.status, text).toBe(200)
      return JSON.parse(text)
    }
    for (const other of [false, true]) await call({ op: 'setup', statements: statsSchema }, other)
    expect(await call({ op: 'contracts' })).toEqual({ passed: true })
    expect(await call({ op: 'rollback' })).toEqual({
      rejected: true,
      counts: { count: 0, uniqueCount: 0 },
    })

    // Separate concurrent events must keep both configuration factories and D1 resources isolated.
    const parallel = await Promise.all([
      call({ op: 'record', key: 'isolated', id: 'a' }),
      call({ op: 'record', key: 'isolated', id: 'b' }, true),
    ])
    expect(parallel).toEqual([
      { count: 1, uniqueCount: 1 },
      { count: 1, uniqueCount: 1 },
    ])
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        call({ op: 'record', key: 'parallel', id: String(i % 3) }),
      ),
    )
    expect(await call({ op: 'record', key: 'parallel', id: '0' })).toEqual({
      count: 13,
      uniqueCount: 3,
    })

    const page = await fetch(`${origin}/counter`, { headers: { 'x-event': 'ssr-event' } })
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('Count <!-- -->1')
    const audit = (await (await fetch(`${origin}/test-audit`)).json()) as {
      event: string
      action: string
      token: string
    }[]
    const ssr = audit.filter((event) => event.event === 'ssr-event')
    expect(ssr.map((event) => event.action)).toEqual(['create', 'record', 'dispose'])
    expect(new Set(ssr.map((event) => event.token)).size).toBe(1)
    expect(
      (await fetch(`${origin}/test-job`, { headers: { 'x-event': 'job-event' } })).status,
    ).toBe(200)
    expect(await call({ op: 'job' })).toEqual({ count: 1 })
    const jobs = ((await (await fetch(`${origin}/test-audit`)).json()) as typeof audit).filter(
      (event) => event.event === 'job-event',
    )
    expect(jobs.map((event) => event.action)).toEqual(['create', 'record', 'dispose'])
    expect(await call({ op: 'plain' }, true)).toEqual({ count: 1 })
  } finally {
    try {
      await server?.close()
    } finally {
      project.remove()
    }
  }
}, 60_000)
