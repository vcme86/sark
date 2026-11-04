import { expect, it } from 'vitest'

import { getCurrentScope } from '../../src/app/context'
import type { RouteEntry } from '../../src/app/http/assembly'
import {
  type AppConfig,
  type AppInstance,
  createApp,
  defineApp,
  route,
} from '../../src/entries/root'
import { createDefinition } from '../../src/entries/runtime/core'
import { startNodeServer } from '../../src/entries/runtime/node'
import { parseApiFilePath } from '../../src/http/path'

async function withApp(
  config: AppConfig,
  routes: RouteEntry[],
  run: (app: AppInstance) => Promise<void>,
) {
  const app = await createApp(createDefinition({ app: defineApp(config), routes }))
  try {
    await run(app)
  } finally {
    await app.close()
  }
}
it('populates clientIp and externalOrigin in ExecutionScope and aligns with CSRF verification', async () => {
  let observedScope: { clientIp?: string; externalOrigin?: string } | undefined

  const routes: RouteEntry[] = [
    {
      routePath: parseApiFilePath('submit.post.ts', '/api')!,
      declaration: route().handler((_ctx) => {
        const scope = getCurrentScope()
        observedScope = {
          clientIp: scope?.clientIp,
          externalOrigin: scope?.externalOrigin,
        }
        return { success: true }
      }),
    },
  ]

  await withApp(
    {
      trustedProxies: ['loopback', 'private'],
      csrf: true,
    },
    routes,
    async (app) => {
      const server = await startNodeServer(app, undefined, { PORT: '0' })
      try {
        const url = `http://127.0.0.1:${server.port}/api/submit`
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'X-Forwarded-For': '203.0.113.88, 10.0.0.1',
            'X-Forwarded-Proto': 'https',
            'X-Forwarded-Host': 'portal.customer.example',
            Origin: 'https://portal.customer.example',
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: 'name=alice',
        })

        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ success: true })
        expect(observedScope?.clientIp).toBe('203.0.113.88')
        expect(observedScope?.externalOrigin).toBe('https://portal.customer.example')

        // If Origin does not match externalOrigin, CSRF triggers 403 csrf_forbidden
        const rejectedRes = await fetch(url, {
          method: 'POST',
          headers: {
            'X-Forwarded-For': '203.0.113.88, 10.0.0.1',
            'X-Forwarded-Proto': 'https',
            'X-Forwarded-Host': 'portal.customer.example',
            Origin: 'https://evil.attacker.example',
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: 'name=alice',
        })

        expect(rejectedRes.status).toBe(403)
        const err = await rejectedRes.json()
        expect(err.error.code).toBe('csrf_forbidden')
      } finally {
        await server.close()
      }
    },
  )
})
