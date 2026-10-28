import { Hono } from 'hono'
import { expect, it, vi } from 'vitest'

import { mountNodeProbes } from '../../src/adapter/node/probes'
import { createDefinition } from '../../src/entries/runtime/core'
import { createApp, route } from '../../src/entries/server'
import { parseApiFilePath } from '../../src/http/path'

it.each([
  ['initializing', 503, 'initializing'],
  ['ready', 200, 'ok'],
  ['draining', 503, 'draining'],
  ['closed', 503, 'closed'],
] as const)('maps readiness state %s to HTTP %s', async (state, status, bodyStatus) => {
  const app = await createApp(createDefinition())
  const stateGetter = vi.spyOn(app, 'state', 'get').mockReturnValue(state)
  const probes = new Hono()
  mountNodeProbes(probes, app, { liveness: '/livez', readiness: '/readyz' })
  try {
    const response = await probes.request('/readyz')
    expect(response.status).toBe(status)
    expect(await response.json()).toEqual({ status: bodyStatus })
    expect(response.headers.get('X-Request-Id')).toBeTruthy()
  } finally {
    stateGetter.mockRestore()
    await app.close()
  }
})

it('keeps business ALL endpoints in probe conflict checks', async () => {
  const app = await createApp(
    createDefinition({
      routes: [
        {
          routePath: parseApiFilePath('livez.all.ts', '/')!,
          declaration: route().handler(() => null),
        },
      ],
    }),
  )
  try {
    expect(() =>
      mountNodeProbes(new Hono(), app, { liveness: '/livez', readiness: '/readyz' }),
    ).toThrow(/ALL \/livez/)
  } finally {
    await app.close()
  }
})
