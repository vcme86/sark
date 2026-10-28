import { expect, it } from 'vitest'

import { createDefinition } from '../../src/entries/runtime/core'
import { startNodeServer } from '../../src/entries/runtime/node'
import { createApp, defineApp, route } from '../../src/entries/server'
import { defineNodeRuntime } from '../../src/entries/server/node'
import { parseApiFilePath } from '../../src/http/path'

it.each(['/api/ping', '/livez', '/readyz'])(
  'preserves common error handling for a rejected Host on %s',
  async (path) => {
    const app = await createApp(
      createDefinition({
        app: defineApp({ hosts: ['allowed.test'] }),
        routes: [
          {
            routePath: parseApiFilePath('ping.get.ts', '/api')!,
            declaration: route().handler(() => ({ ok: true })),
          },
        ],
      }),
    )
    const host = await startNodeServer(app, defineNodeRuntime({ port: 0, hostname: '127.0.0.1' }))
    try {
      for (const method of ['GET', 'HEAD']) {
        const response = await fetch(`http://127.0.0.1:${host.port}${path}`, { method })
        expect(response.status).toBe(400)
        expect(response.headers.get('X-Request-Id')).toBeTruthy()
        expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
        if (method === 'HEAD') expect(await response.text()).toBe('')
        else expect((await response.json()).error.code).toBe('invalid_host')
      }
    } finally {
      await host.close()
    }
  },
)

it.each([true, false])(
  'uses forwarding metadata only from a trusted Node peer (trusted=%s)',
  async (trusted) => {
    const app = await createApp(
      createDefinition({
        app: defineApp({ trustedProxies: trusted ? ['loopback'] : [] }),
        routes: [
          {
            routePath: parseApiFilePath('ping.get.ts', '/api')!,
            declaration: route().handler((ctx) => ({ id: ctx.var.requestId })),
          },
        ],
      }),
    )
    const host = await startNodeServer(app, defineNodeRuntime({ port: 0, hostname: '127.0.0.1' }))
    try {
      const origin = `http://127.0.0.1:${host.port}`
      const headers = {
        'X-Forwarded-Proto': 'https',
        'X-Forwarded-Host': 'public.example',
        'X-Request-Id': 'proxy-request-id',
        'CF-Ray': 'client-supplied-ray',
      }
      const response = await fetch(`${origin}/api/ping`, { headers })
      const id = response.headers.get('X-Request-Id')
      expect(id).toBeTruthy()
      expect(await response.json()).toEqual({ id })
      if (trusted) expect(id).toBe('proxy-request-id')
      else {
        expect(id).not.toBe('proxy-request-id')
        expect(id).not.toBe('client-supplied-ray')
      }
      const redirect = await fetch(`${origin}/api/ping/?q=book`, { headers, redirect: 'manual' })
      expect(redirect.status).toBe(308)
      expect(redirect.headers.get('Location')).toBe(
        `${trusted ? 'https://public.example' : origin}/api/ping?q=book`,
      )
    } finally {
      await host.close()
    }
  },
)
