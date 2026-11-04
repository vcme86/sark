import { createServer, type ViteDevServer } from 'vite'
import { expect, it } from 'vitest'
import { WebSocket } from 'ws'

import { createProject, serverUrl, viteEntry } from '../helpers/project'

it('runs generated jobs, rate limiting and async event logging in workerd using the selected Wrangler environment', async () => {
  const project = createProject()
  const previousEnv = process.env.CLOUDFLARE_ENV
  const previousPath = process.env.CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH
  let server: ViteDevServer | undefined
  try {
    project.write(
      'app.ts',
      `
import type { R2Bucket } from '@cloudflare/workers-types'
import { defineJobs } from '@olivaw/sark/jobs'
import { defineLogging } from '@olivaw/sark/logging'
import { defineRateLimit } from '@olivaw/sark/middleware'
type Env = { LOGS: R2Bucket }
export const rateLimit = defineRateLimit({ binding: 'LIMITER', key: ctx => ctx.req.url })
export const logging = defineLogging((env: Env) => ({
  access: ['remote'], categories: { app: ['remote'] },
  sinks: { remote: () => {
    const records: Array<{ category: readonly string[]; message: readonly unknown[]; properties: Record<string, unknown> }> = []
    return Object.assign((record: typeof records[number]) => { records.push(record) }, {
      async [Symbol.asyncDispose]() {
        const access = records.find(record => record.category.join('/') === 'sark/access')
        const key = access ? 'http/' + access.properties.requestId : 'scheduled/log'
        await env.LOGS.put(key, JSON.stringify(records))
      },
    })
  } },
}))
export const jobs = defineJobs((env: Env) => [
  { name: 'hourly', onCron: '0 * * * *', handler: async ({ logger }) => {
    logger.info('hourly work completed')
    await env.LOGS.put('scheduled/result', JSON.stringify({ result: 'executed with event bindings' }))
  } },
  { name: 'failing', onCron: '0 1 * * *', handler() { throw new Error('scheduled failure') } },
])
`,
    )
    project.write(
      'api/hello.get.ts',
      `
import { getLogger, route } from '@olivaw/sark'
export default route().handler(() => { getLogger().info('hello workerd'); return { ok: true } })
`,
    )
    project.write(
      'api/quota.get.ts',
      `
import { route } from '@olivaw/sark'
export default route().handler(() => ({ allowed: true }))
`,
    )
    project.write(
      'api/logs.get.ts',
      `
import { route } from '@olivaw/sark'
export default route().handler(async ctx => {
  const object = await ctx.env.LOGS.get(ctx.req.query('key'))
  return object ? new Response(await object.text()) : new Response(null, { status: 404 })
})
`,
    )
    project.write(
      'api/echo.ws.ts',
      `
import { getLogger, route } from '@olivaw/sark'
export default route().handler(() => ({
  onMessage(socket, data) { getLogger().info('socket work'); socket.send(data); socket.close() },
}))
`,
    )
    project.write(
      '.env.review',
      'CLOUDFLARE_ENV=review\nCLOUDFLARE_VITE_WRANGLER_CONFIG_PATH=config/worker.jsonc\n',
    )
    project.write(
      'config/worker.jsonc',
      JSON.stringify({
        name: 'operations',
        main: '../.build/worker.ts',
        compatibility_date: '2026-10-01',
        compatibility_flags: ['nodejs_compat'],
        env: {
          review: {
            triggers: { crons: ['0 * * * *', '0 1 * * *'] },
            r2_buckets: [{ binding: 'LOGS', bucket_name: 'operation-logs' }],
            ratelimits: [
              { name: 'LIMITER', namespace_id: '1001', simple: { limit: 2, period: 60 } },
            ],
          },
        },
      }),
    )
    project.write(
      'vite.config.mts',
      `
import { sark } from ${JSON.stringify(viteEntry)}
import { cloudflare } from '@cloudflare/vite-plugin'
export default { cacheDir: '.build/vite-cache', plugins: [sark({ target: 'cloudflare', webDir: false }), cloudflare({ viteEnvironment: { name: 'ssr' }, inspectorPort: false, persistState: false, remoteBindings: false })] }
`,
    )
    server = await createServer({
      root: project.root,
      mode: 'review',
      logLevel: 'silent',
      server: { host: '127.0.0.1', port: 0 },
    })
    await server.listen()
    const url = serverUrl(server.httpServer)
    const hello = await fetch(`${url}/api/hello`)
    expect(await hello.json()).toEqual({ ok: true })
    const readLog = async (key: string) => {
      const response = await fetch(
        `${url}/api/logs?key=${encodeURIComponent(key)}&read=${crypto.randomUUID()}`,
      )
      return response.status === 200 ? response.json() : undefined
    }
    let records: Array<{ category: string[]; message: unknown[] }> | undefined
    await expect
      .poll(async () => {
        records = await readLog(`http/${hello.headers.get('x-request-id')}`)
        return records !== undefined
      })
      .toBe(true)
    expect(records!.filter((record) => record.category.join('/') === 'sark/access')).toHaveLength(1)
    expect(records!.some((record) => record.message.includes('hello workerd'))).toBe(true)

    const statuses: number[] = []
    for (let i = 0; i < 3; i++) {
      const response = await fetch(`${url}/api/quota`)
      statuses.push(response.status)
      await response.text()
    }
    expect(statuses).toEqual([200, 200, 429])

    let handshakeId: string | undefined
    const socket = new WebSocket(url.replace('http:', 'ws:') + '/api/echo')
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('upgrade', (response) => {
          handshakeId = String(response.headers['x-request-id'])
        })
        socket.once('open', () => socket.send('echo'))
        socket.once('error', reject)
        socket.once('close', () => resolve())
      })
      await expect
        .poll(async () => {
          const logs = (await readLog(`http/${handshakeId}`)) as
            | Array<{ message: unknown[] }>
            | undefined
          return logs?.some((record) => record.message.includes('socket work'))
        })
        .toBe(true)
    } finally {
      socket.terminate()
    }

    const scheduled = await fetch(
      `${url}/cdn-cgi/local/scheduled?cron=${encodeURIComponent('0 * * * *')}`,
    )
    expect(scheduled.status, await scheduled.text()).toBe(200)
    await expect
      .poll(() => readLog('scheduled/result'))
      .toEqual({ result: 'executed with event bindings' })
    await expect
      .poll(async () => {
        const logs = (await readLog('scheduled/log')) as Array<{ message: unknown[] }> | undefined
        return logs?.some((record) => record.message.includes('hourly work completed'))
      })
      .toBe(true)
    const failed = await fetch(
      `${url}/cdn-cgi/local/scheduled?cron=${encodeURIComponent('0 1 * * *')}`,
    )
    expect(failed.status, await failed.text()).toBe(500)
  } finally {
    try {
      await server?.close()
    } finally {
      project.remove()
      if (previousEnv === undefined) delete process.env.CLOUDFLARE_ENV
      else process.env.CLOUDFLARE_ENV = previousEnv
      if (previousPath === undefined) delete process.env.CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH
      else process.env.CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH = previousPath
    }
  }
}, 45000)
