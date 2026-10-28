import { afterEach, expect, it, vi } from 'vitest'

import { createDefinition } from '../../src/entries/runtime/core'
import { createApp, defineApp, route, z } from '../../src/entries/server'
import { parseApiFilePath } from '../../src/http/path'

afterEach(() => vi.unstubAllEnvs())
it.each(['unknown-proxy', '192.168.0.0/33', '10.0.0.0/8extra'])(
  'rejects invalid trusted proxy configuration before request handling: %s',
  async (rule) => {
    await expect(
      createApp(
        createDefinition({
          app: defineApp({ trustedProxies: [rule] }),
        }),
      ),
    ).rejects.toThrow(/http.trustedProxies/)
  },
)

it('evaluates declaration factories once per instance after environment is available', async () => {
  const factory = vi.fn((env: { limit: number }) => ({ bodyLimit: env.limit }))
  const definition = createDefinition({ app: defineApp(factory) })
  expect(factory).not.toHaveBeenCalled()
  const first = await createApp(definition, { env: { limit: 4 } })
  const second = await createApp(definition, { env: { limit: 9 } })
  try {
    expect(first.config.bodyLimit).toBe(4)
    expect(second.config.bodyLimit).toBe(9)
    await first.fetch(new Request('https://example.test/missing'))
    expect(factory).toHaveBeenCalledTimes(2)
  } finally {
    await Promise.all([first.close(), second.close()])
  }
})

it('rejects GET body declarations before creating resources', async () => {
  const create = vi.fn(async () => ({ value: {} }))
  await expect(
    createApp(
      createDefinition({
        resources: { db: { target: 'node', createStatic: create } },
        routes: [
          {
            routePath: parseApiFilePath('items.get.ts', '/api')!,
            declaration: route()
              .validate({ json: z.object({ value: z.string() }) })
              .handler(() => null),
          },
        ],
      }),
    ),
  ).rejects.toThrow(/GET routes cannot declare a request body schema/)
  expect(create).not.toHaveBeenCalled()
})
