import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { createServer, preview, type PreviewServer, type ViteDevServer } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createProject, runProjectCli, serverUrl, viteEntry } from '../helpers/project'

function application(target: 'node' | 'cloudflare') {
  const project = createProject()
  const appEntry = target === 'cloudflare' ? 'config/application.ts' : 'app.ts'
  const apiDir = target === 'cloudflare' ? 'handlers' : 'api'
  const generatedDir = target === 'cloudflare' ? 'generated/runtime' : '.build'
  const apiPrefix = target === 'cloudflare' ? '/service/v2/api' : '/api'
  project.write(
    appEntry,
    `import { defineApp } from '@olivaw/sark/server'
export const app = defineApp((env: { RELEASE?: string }) => ({
  headers: { 'X-Release': env.RELEASE ?? 'node' },
}))`,
  )
  project.write(
    `${apiDir}/users/_middleware.ts`,
    `import { createMiddleware } from 'hono/factory'
export default createMiddleware(async (ctx, next) => {
  await next()
  ctx.header('X-Users-Middleware', 'applied')
})`,
  )
  project.write(
    `${apiDir}/users/get.ts`,
    `import { route } from '@olivaw/sark/server'
export default route().handler(() => ({ users: [] }))`,
  )
  project.write(
    `${apiDir}/users/[id].get.ts`,
    `import { route, z } from '@olivaw/sark/server'
export default route().validate({ params: z.object({ id: z.string() }) }).handler((ctx, input) => {
  let hasWaitUntil = false
  try { hasWaitUntil = typeof ctx.executionCtx.waitUntil === 'function' } catch {}
  if (hasWaitUntil) ctx.executionCtx.waitUntil(Promise.resolve())
  return { id: input.params.id, hasWaitUntil, release: ctx.env?.RELEASE ?? 'node' }
})`,
  )
  project.write(
    `${apiDir}/users/post.ts`,
    `import { route, z } from '@olivaw/sark/server'
export default route().validate({ json: z.object({ name: z.string(), role: z.enum(['admin', 'member']) }) })
.handler((_ctx, input) => ({ created: true, user: input.json }))`,
  )
  project.write(
    `${apiDir}/client-info.get.ts`,
    `import { route } from '@olivaw/sark/server'
export default route().handler(() => ({ ok: true }))`,
  )
  project.write(
    `${apiDir}/mode.get.ts`,
    `import { route, setCookie } from '@olivaw/sark/server'
export default route().handler(ctx => {
  setCookie(ctx, 'mode', 'current')
  return { ok: true }
})`,
  )
  project.write(
    'vite.config.mts',
    `import { sark } from ${JSON.stringify(viteEntry)}
${target === 'cloudflare' ? "import { cloudflare } from '@cloudflare/vite-plugin'" : ''}
export default { plugins: [sark({ target: '${target}', appEntry: '${appEntry}', apiDir: '${apiDir}', generatedDir: '${generatedDir}', apiPrefix: '${apiPrefix}' })${target === 'cloudflare' ? ", cloudflare({ viteEnvironment: { name: 'ssr' }, inspectorPort: false, persistState: false, remoteBindings: false })" : ''}] }`,
  )
  if (target === 'cloudflare')
    project.write(
      'wrangler.jsonc',
      JSON.stringify({
        name: 'sark-contract',
        main: `${generatedDir}/worker.ts`,
        compatibility_date: '2026-10-01',
        compatibility_flags: ['nodejs_compat'],
        vars: { RELEASE: 'worker' },
      }),
    )
  return project
}

for (const mode of ['development', 'production preview'] as const) {
  describe(`Workers ${mode} against a generated Node dev server`, () => {
    let worker: ReturnType<typeof application>
    let node: ReturnType<typeof application>
    let workerServer: ViteDevServer | PreviewServer | undefined
    let nodeServer: ViteDevServer | undefined
    let workerUrl: string
    let nodeUrl: string

    beforeAll(async () => {
      worker = application('cloudflare')
      node = application('node')
      nodeServer = await createServer({
        root: node.root,
        logLevel: 'silent',
        server: { host: '127.0.0.1', port: 0 },
      })
      await nodeServer.listen()
      nodeUrl = serverUrl(nodeServer.httpServer)
      // A fresh project has no generated Worker until Sark runs before the official plugin.
      expect(existsSync(join(worker.root, 'generated/runtime/worker.ts'))).toBe(false)
      if (mode === 'development') {
        const dev = await createServer({
          root: worker.root,
          logLevel: 'silent',
          server: { host: '127.0.0.1', port: 0 },
        })
        workerServer = dev
        await dev.listen()
      } else {
        const result = runProjectCli(worker.root, ['build'], { NODE_ENV: 'production' })
        expect(result.status, result.stdout + result.stderr).toBe(0)
        expect(existsSync(join(worker.root, 'dist/ssr/wrangler.json'))).toBe(true)
        workerServer = await preview({
          root: worker.root,
          logLevel: 'silent',
          preview: { host: '127.0.0.1', port: 0 },
        })
      }
      workerUrl = serverUrl(workerServer.httpServer) + '/service/v2'
      expect(existsSync(join(worker.root, 'generated/runtime/start.ts'))).toBe(false)
    }, 45000)

    afterAll(async () => {
      try {
        await workerServer?.close()
      } finally {
        try {
          await nodeServer?.close()
        } finally {
          worker?.remove()
          node?.remove()
        }
      }
    })

    it('discovers routes, loads factory bindings and passes the actual Worker execution context', async () => {
      const workerResponse = await fetch(`${workerUrl}/api/users/Alice`)
      const nodeResponse = await fetch(`${nodeUrl}/api/users/Alice`)
      expect(workerResponse.status).toBe(200)
      expect(nodeResponse.status).toBe(200)
      expect(workerResponse.headers.get('X-Release')).toBe('worker')
      expect(await workerResponse.json()).toEqual({
        id: 'Alice',
        release: 'worker',
        hasWaitUntil: true,
      })
      const nodeBody = await nodeResponse.json()
      expect(nodeBody.id).toBe('Alice')
      expect(nodeBody.hasWaitUntil).toBe(false)
    })

    it('executes default-only ancestor middleware for method-only route files on both targets', async () => {
      for (const url of [nodeUrl, workerUrl]) {
        const response = await fetch(`${url}/api/users`)
        expect(response.status).toBe(200)
        expect(response.headers.get('X-Users-Middleware')).toBe('applied')
        expect(await response.json()).toEqual({ users: [] })
      }
    })

    it('validates JSON input and returns the same validation response on both targets', async () => {
      const errors = []
      for (const url of [nodeUrl, workerUrl]) {
        const send = (role: string) =>
          fetch(`${url}/api/users`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Bob', role }),
          })
        const valid = await send('admin')
        expect(valid.status).toBe(200)
        expect(await valid.json()).toEqual({ created: true, user: { name: 'Bob', role: 'admin' } })
        const invalid = await send('unknown')
        expect(invalid.status).toBe(400)
        const body = await invalid.json()
        expect(body.error.code).toBe('http_error')
        errors.push(body)
      }
      expect(errors[0]).toEqual(errors[1])
    })

    it('returns matching 404/405 semantics and strips HEAD bodies on both targets', async () => {
      for (const url of [nodeUrl, workerUrl]) {
        const absent = await fetch(`${url}/api/missing`)
        expect(absent.status).toBe(404)
        const rejected = await fetch(`${url}/api/users/42`, { method: 'PUT' })
        expect(rejected.status).toBe(405)
        expect(rejected.headers.get('Allow')).toBe('GET, HEAD')
        const head = await fetch(`${url}/api/users/42`, { method: 'HEAD' })
        expect(head.status).toBe(200)
        expect(await head.text()).toBe('')
      }
    })

    it('assigns a request identifier to the Worker response', async () => {
      const response = await fetch(`${workerUrl}/api/client-info`, {
        headers: { 'X-Request-Id': 'worker-contract' },
      })
      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body).toEqual({ ok: true })
      expect(response.headers.get('X-Request-Id')).toBeTruthy()
    })

    it('receives the build mode from Vite and applies the corresponding Cookie defaults', async () => {
      const response = await fetch(`${workerUrl}/api/mode`)
      expect(response.status).toBe(200)
      const cookie = response.headers.get('Set-Cookie')!
      expect(cookie).toContain('SameSite=Lax')
      expect(cookie.includes('Secure')).toBe(mode === 'production preview')
    })

    it('does not mount Node probes in Workers', async () => {
      for (const path of ['/livez', '/readyz'])
        expect((await fetch(serverUrl(workerServer!.httpServer) + path)).status).toBe(404)
    })
  })
}
