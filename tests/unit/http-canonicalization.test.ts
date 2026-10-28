import { expect, it, vi } from 'vitest'

import { route } from '../../src/entries/server'
import { resolveHttpConfig } from '../../src/http/config'
import { createRouteCanonicalizer, parseApiFilePath } from '../../src/http/path'
import { buildHttpApp } from '../../src/http/server/pipeline'

vi.mock('../../src/http/path', async (load) => {
  const original = await load<typeof import('../../src/http/path')>()
  return { ...original, createRouteCanonicalizer: vi.fn(original.createRouteCanonicalizer) }
})

it('creates canonicalization only when needed and respects later event policies', async () => {
  let config = resolveHttpConfig({ caseSensitive: true })
  const app = buildHttpApp(
    () => config,
    [
      {
        routePath: parseApiFilePath('Docs.[id].get.ts', '/api')!,
        declaration: route().handler((ctx) => ({ id: ctx.req.param('id') })),
      },
    ],
  )
  const fetch = (path: string) => app.fetch(new Request(`https://example.test${path}`))
  expect(createRouteCanonicalizer).not.toHaveBeenCalled()
  expect((await fetch('/api/Docs/ReadMe')).status).toBe(200)
  expect((await fetch('/api/docs/ReadMe')).status).toBe(404)
  expect(createRouteCanonicalizer).not.toHaveBeenCalled()

  config = resolveHttpConfig({ caseSensitive: false })
  const redirect = await fetch('/api/docs/ReadMe')
  expect(redirect.status).toBe(308)
  expect(redirect.headers.get('location')).toBe('https://example.test/api/Docs/ReadMe')
  expect(createRouteCanonicalizer).toHaveBeenCalledOnce()

  config = resolveHttpConfig({ caseSensitive: true })
  expect((await fetch('/api/docs/ReadMe')).status).toBe(404)
  config = resolveHttpConfig({ caseSensitive: false })
  expect(await (await fetch('/api/Docs/ReadMe')).json()).toEqual({ id: 'ReadMe' })
  expect(createRouteCanonicalizer).toHaveBeenCalledOnce()
})
