import { expect, it } from 'vitest'

import type { RouteEntry } from '../../src/app/http/assembly'
import type { RouteDeclaration } from '../../src/app/http/types'
import { defineNodeRuntime } from '../../src/entries/node'
import { createApp, route } from '../../src/entries/root'
import { createDefinition } from '../../src/entries/runtime/core'
import { startNodeServer } from '../../src/entries/runtime/node'
import { parseApiFilePath } from '../../src/http/path'

function entry(source: string, declaration: RouteDeclaration, prefix = '/api'): RouteEntry {
  return { source, routePath: parseApiFilePath(source, prefix)!, declaration }
}
it('rejects an enabled probe collision before listening and releases the application', async () => {
  const app = await createApp(
    createDefinition({
      routes: [
        entry(
          'readyz.get.ts',
          route().handler(() => ({ business: true })),
          '/',
        ),
      ],
    }),
  )
  try {
    await expect(startNodeServer(app, defineNodeRuntime({ port: 0 }))).rejects.toThrow(
      /readiness.*readyz.get.ts/,
    )
    expect(app.state).toBe('closed')
  } finally {
    await app.close()
  }
})

it('permits the same probe path for another method or when probes are disabled', async () => {
  for (const { probes, method } of [
    { probes: false, method: 'GET' },
    { probes: { liveness: '/livez', readiness: '/readyz' }, method: 'POST' },
  ] as const) {
    const app = await createApp(
      createDefinition({
        routes: [
          entry(
            `readyz.${method.toLowerCase()}.ts`,
            route().handler(() => ({ business: true })),
            '/',
          ),
        ],
      }),
    )
    const host = await startNodeServer(
      app,
      defineNodeRuntime({ port: 0, hostname: '127.0.0.1', probes }),
    )
    try {
      const response = await fetch(`http://127.0.0.1:${host.port}/readyz`, {
        method,
        headers: { Origin: `http://127.0.0.1:${host.port}` },
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ business: true })
    } finally {
      await host.close()
    }
  }
})
