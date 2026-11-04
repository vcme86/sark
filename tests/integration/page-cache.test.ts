import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer as createSocket } from 'node:net'
import { join } from 'node:path'

import { preview } from 'vite'
import { expect, it } from 'vitest'

import { createPageProject } from '../helpers/page-project'
import { runProjectCli, serverUrl } from '../helpers/project'
import { checkGeneratedTypes } from '../helpers/typecheck'

it('checks generated Node cache, metrics, bindings, jobs and startup types together', async () => {
  const result = await checkGeneratedTypes({
    'app.ts': `import { defineApp } from '@olivaw/sark'
import { definePageCache } from '@olivaw/sark/page/cache'
import { defineMetrics } from '@olivaw/sark/node'
import { defineJobs } from '@olivaw/sark/jobs'
export const app = defineApp({})
export const pageCache = definePageCache()
export const metrics = defineMetrics({ runtime: false })
export const jobs = defineJobs([{ name: 'work', schedule: '0 * * * *', handler(ctx) {
  ctx.metrics.counter({ name: 'jobs_seen', help: 'Seen jobs' }).inc()
  ctx.cache.revalidateTag('article')
} }])`,
    'api/inspect.get.ts': `import { route } from '@olivaw/sark'
export default route().handler(async ctx => {
  ctx.var.metrics.counter({ name: 'api_seen', help: 'Seen calls' }).inc()
  await ctx.var.cache.revalidatePath('/')
  return { ok: true }
})`,
  })
  expect(result.status, result.output).toBe(0)
})

for (const target of ['node', 'cloudflare'] as const) {
  it(`runs generated ${target} caching, merged SWR and invalidation with real internal API calls`, async () => {
    const project = createPageProject(target)
    project.write(
      'app.ts',
      `import { defineApp } from '@olivaw/sark'
import { definePageCache } from '@olivaw/sark/page/cache'
${target === 'node' ? "import { defineMetrics } from '@olivaw/sark/node'\nexport const metrics = defineMetrics({ runtime: false })" : ''}
export const pageCache = definePageCache()
export const app = defineApp({ csrf: false, middleware: [async (ctx, next) => {
  await next()
  if (ctx.req.path === '/site/cached') ctx.header('Cache-Control', 'public,max-age=0,stale-while-revalidate=60')
}] })`,
    )
    project.write(
      'state.ts',
      `export let calls = 0
let waiting = false
let release: (() => void) | undefined
export function arm() { waiting = true }
export function resume() { release?.(); waiting = false }
export function status() { return { calls, waiting: Boolean(release) } }
export async function data() {
  const version = ++calls
  if (waiting) await new Promise<void>(resolve => { release = () => { release = undefined; resolve() } })
  return { version }
}`,
    )
    project.write(
      'api/data.get.ts',
      `import { route } from '@olivaw/sark'
import { data } from '../state'
export default route().handler(() => data())`,
    )
    project.write(
      'api/control.get.ts',
      `import { route } from '@olivaw/sark'
import { arm, resume, status } from '../state'
import { revalidateTag } from '@olivaw/sark/page/cache'
export default route().handler(async ctx => {
  const action = ctx.req.query('action')
  if (action === 'arm') arm()
  if (action === 'release') resume()
  if (action === 'invalidate') await revalidateTag('article')
  return status()
})`,
    )
    project.write(
      'app/cached.tsx',
      `import type { LoaderArgs } from '@olivaw/sark/page'
export const cache = { ttl: 60, tags: ['article'] }
export async function loader({ client, signal }: LoaderArgs) {
  return client.get('/data', { init: { signal } })
}
export default function Page({ data }: { data: { version: number } }) { return <h1>Version {data.version}</h1> }`,
    )
    let close: (() => Promise<void>) | undefined
    let origin = ''
    try {
      const built = runProjectCli(project.root, ['build'], { NODE_ENV: 'production' })
      expect(built.status, built.stdout + built.stderr).toBe(0)
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
        await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve))
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
        child.stdout.on('data', (data) => {
          diagnostics += data
        })
        child.stderr.on('data', (data) => {
          diagnostics += data
        })
        const exited = once(child, 'exit')
        close = async () => {
          child.kill('SIGTERM')
          await exited
        }
        origin = `http://127.0.0.1:${port}`
        await expect
          .poll(async () => {
            if (child.exitCode !== null) throw new Error(diagnostics)
            try {
              return (await fetch(origin + '/service/v2/control')).status
            } catch {
              return 0
            }
          })
          .toBe(200)
      }
      const control = async (action = '') =>
        (await fetch(origin + '/service/v2/control?action=' + action)).json()
      const page = () => fetch(origin + '/site/cached')
      const first = await page()
      expect(await first.text()).toContain('<h1>Version <!-- -->1</h1>')
      await control('arm')
      const stale = await page()
      expect(stale.headers.has('age')).toBe(true)
      expect(await stale.text()).toContain('Version <!-- -->1')
      await expect.poll(async () => (await control()).waiting).toBe(true)
      const merged = await page()
      expect(await merged.text()).toContain('Version <!-- -->1')
      expect((await control()).calls).toBe(2)
      await control('release')
      // Wait for a completed newer representation, not an arbitrary delay.
      await expect.poll(async () => await (await page()).text()).toContain('Version <!-- -->2')
      await control('invalidate')
      const fresh = await page()
      expect(fresh.headers.has('age')).toBe(false)
      expect(await fresh.text()).not.toContain('Version <!-- -->1')
      if (target === 'node') {
        const text = await (await fetch(origin + '/metrics')).text()
        expect(text).toContain('route="/site/cached"')
        expect(text).not.toContain('route="/service/v2/data"')
      }
    } finally {
      if (origin) await fetch(origin + '/service/v2/control?action=release').catch(() => {})
      try {
        await close?.()
      } finally {
        project.remove()
      }
    }
  }, 45000)
}
