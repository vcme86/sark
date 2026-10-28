import { Hono } from 'hono'
import { expect, it, vi } from 'vitest'

import { startNodeServer } from '../../src/adapter/node/listen'
import { mountNodeProbes } from '../../src/adapter/node/probes'
import { defineNodeRuntime } from '../../src/adapter/node/runtime'
import { defineOAuth } from '../../src/entries/auth/oauth'
import { createDefinition } from '../../src/entries/runtime/core'
import { createApp, defineApp } from '../../src/entries/server'
import { createOAuthAssembly } from '../../src/services/auth/oauth/assembly'
it('rejects a probe shadowing an assembled OAuth endpoint', async () => {
  const dispose = vi.fn()
  const app = await createApp(
    createDefinition({
      app: defineApp({ cookie: { secret: 'oauth-cookie-secret-long-enough' } }),
      resources: { db: { target: 'node', createStatic: async () => ({ value: {}, dispose }) } },
      services: {
        oauth: createOAuthAssembly(
          defineOAuth([
            {
              id: 'github',
              kind: 'github',
              clientId: 'client',
              clientSecret: 'secret',
              scopes: [],
              signInPath: '/livez',
              redirectUri: 'https://example.test/callback',
              onSuccess() {},
            },
          ]),
          '/api',
        ),
      },
    }),
  )
  try {
    expect(() =>
      mountNodeProbes(new Hono(), app, { liveness: '/livez', readiness: '/readyz' }),
    ).toThrow(/Route conflict.*GET \/livez/)
    await expect(startNodeServer(app, defineNodeRuntime({ port: 0 }))).rejects.toThrow(
      /Route conflict/,
    )
    expect(dispose).toHaveBeenCalledOnce()
    expect(app.state).toBe('closed')
  } finally {
    await app.close()
  }
})
