import { createServer, type ViteDevServer } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createProject, serverUrl, viteEntry } from '../helpers/project'

for (const target of ['node', 'cloudflare'] as const) {
  describe(`${target} request body limits over HTTP`, () => {
    let project: ReturnType<typeof createProject>
    let server: ViteDevServer | undefined
    let url: string

    beforeAll(async () => {
      project = createProject()
      project.write(
        'app.ts',
        `import { defineApp } from '@olivaw/sark/server'
import { observations } from './progress'
export const app = defineApp({
  csrf: false, bodyLimit: 256,
  middleware: [async (ctx, next) => {
    const id = ctx.req.header('X-Case')
    if (id) observations.set(id, { length: ctx.req.header('content-length') ?? null, handler: false })
    await next()
  }],
})`,
      )
      for (const kind of ['json', 'text', 'form'])
        project.write(
          `api/${kind}.post.ts`,
          `import { route, z } from '@olivaw/sark/server'
import { observations } from '../progress'
export default route().validate({ ${kind}: ${kind === 'text' ? 'z.string()' : 'z.object({ value: z.string() })'} })
  .handler((ctx, input) => { observations.get(ctx.req.header('X-Case')!)!.handler = true; return input.${kind} })`,
        )
      project.write(
        'api/disabled.post.ts',
        `import { route, z } from '@olivaw/sark/server'
export default route({ bodyLimit: false }).validate({ text: z.string() })
  .handler((_ctx, input) => ({ size: input.text.length }))`,
      )
      // A separate request observes consumption before the upload source is allowed to finish.
      project.write(
        'progress.ts',
        `export const progress = Promise.withResolvers<{ bytes: number; length: string | null }>()
export const observations = new Map<string, { length: string | null; handler: boolean }>()`,
      )
      project.write(
        'api/observation.get.ts',
        `import { route } from '@olivaw/sark/server'
import { observations } from '../progress'
export default route().handler(ctx => observations.get(ctx.req.query('id')!) ?? null)`,
      )
      project.write(
        'api/progress.get.ts',
        `import { route } from '@olivaw/sark/server'
import { progress } from '../progress'
export default route().handler(() => progress.promise)`,
      )
      project.write(
        'api/stream.post.ts',
        `import { route } from '@olivaw/sark/server'
import { progress } from '../progress'
export default route().handler(async ctx => {
  const reader = ctx.req.raw.body!.getReader()
  try {
    const first = await reader.read()
    progress.resolve({ bytes: first.value!.byteLength, length: ctx.req.header('content-length') ?? null })
    while (!(await reader.read()).done) {}
    return { ok: true }
  } finally { reader.releaseLock() }
})`,
      )
      project.write(
        'vite.config.mts',
        `import { sark } from ${JSON.stringify(viteEntry)}
${target === 'cloudflare' ? "import { cloudflare } from '@cloudflare/vite-plugin'" : ''}
export default { cacheDir: '.build/vite-cache', plugins: [sark({ target: '${target}', webDir: false })${target === 'cloudflare' ? ", cloudflare({ viteEnvironment: { name: 'ssr' }, inspectorPort: false, persistState: false, remoteBindings: false })" : ''}] }`,
      )
      if (target === 'cloudflare')
        project.write(
          'wrangler.jsonc',
          JSON.stringify({
            name: 'sark-body-limit',
            main: '.build/worker.ts',
            compatibility_date: '2026-10-01',
            compatibility_flags: ['nodejs_compat'],
          }),
        )
      server = await createServer({
        root: project.root,
        logLevel: 'silent',
        server: { host: '127.0.0.1', port: 0 },
      })
      await server.listen()
      url = serverUrl(server.httpServer)
    }, 30000)

    afterAll(async () => {
      try {
        await server?.close()
      } finally {
        project?.remove()
      }
    })

    it('rejects oversized Content-Length before business middleware', async () => {
      const id = crypto.randomUUID()
      const response = await fetch(`${url}/api/text`, {
        method: 'POST',
        body: 'x'.repeat(257),
        headers: { 'X-Case': id },
      })
      expect(response.status).toBe(413)
      await response.text()
      expect(await (await fetch(`${url}/api/observation?id=${id}`)).json()).toBeNull()
      const valid = await fetch(`${url}/api/text`, {
        method: 'POST',
        body: 'x'.repeat(256),
        headers: { 'X-Case': id },
      })
      expect(valid.status).toBe(200)
      await valid.text()
      expect(await (await fetch(`${url}/api/observation?id=${id}`)).json()).toEqual({
        length: '256',
        handler: true,
      })
    })

    for (const kind of ['json', 'text', 'urlencoded', 'multipart'] as const)
      it(`preserves streamed ${kind} input and returns 413 before the schema handler on excess`, async () => {
        for (const size of [3, 512]) {
          const id = crypto.randomUUID()
          const value = 'x'.repeat(size)
          const form = new FormData()
          form.set('value', value)
          const payload = new Request('https://payload.example', {
            method: 'POST',
            body:
              kind === 'json'
                ? JSON.stringify({ value })
                : kind === 'text'
                  ? value
                  : kind === 'urlencoded'
                    ? new URLSearchParams({ value })
                    : form,
            ...(kind === 'json' ? { headers: { 'Content-Type': 'application/json' } } : {}),
          })
          const response = await fetch(
            `${url}/api/${kind === 'urlencoded' || kind === 'multipart' ? 'form' : kind}`,
            {
              method: 'POST',
              headers: { ...Object.fromEntries(payload.headers), 'X-Case': id },
              body: payload.body,
              duplex: 'half',
            } as RequestInit,
          )
          expect(response.status).toBe(size === 3 ? 200 : 413)
          if (size === 3) expect(await response.json()).toEqual(kind === 'text' ? value : { value })
          else expect((await response.json()).error.code).toBe('http_error')
          expect(await (await fetch(`${url}/api/observation?id=${id}`)).json()).toEqual({
            length: null,
            handler: size === 3,
          })
        }
      })

    it('keeps malformed input at 400 and disabled limits allow larger streamed input', async () => {
      const malformed = await fetch(`${url}/api/json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{',
      })
      expect(malformed.status).toBe(400)
      await malformed.text()
      const response = await fetch(`${url}/api/disabled`, {
        method: 'POST',
        body: new Blob(['x'.repeat(512)]).stream(),
        duplex: 'half',
      } as RequestInit)
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ size: 512 })
    })

    it('lets a raw handler consume the first chunk before upload completion', async () => {
      const controller = new AbortController()
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10000)])
      let source!: ReadableStreamDefaultController<Uint8Array>
      const body = new ReadableStream<Uint8Array>({
        start(value) {
          source = value
          source.enqueue(new Uint8Array(2))
        },
      })
      const upload = fetch(`${url}/api/stream`, {
        method: 'POST',
        body,
        duplex: 'half',
        signal,
      } as RequestInit)
      // Attach rejection handling immediately; the assertion request may fail before upload settles.
      const result = upload.then(
        (response) => ({ response }),
        (error) => ({ error }),
      )
      try {
        const response = await fetch(`${url}/api/progress`, { signal })
        expect(await response.json()).toEqual({ bytes: 2, length: null })
        source.enqueue(new Uint8Array(255))
        source.close()
        const completed = await result
        if ('error' in completed) throw completed.error
        expect(completed.response.status).toBe(413)
        await completed.response.text()
      } finally {
        controller.abort()
        await result
      }
    }, 15000)
  })
}
