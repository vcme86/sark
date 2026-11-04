import { expect, it } from 'vitest'

import { resolveHttpConfig } from '../../src/app/config'
import { buildHttpApp } from '../../src/app/http/pipeline'
import { route } from '../../src/entries/root'
import { createRequestPathResolver, parseApiFilePath } from '../../src/http/path'

it('applies later event policies without changing parameter case', async () => {
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
  expect((await fetch('/api/Docs/ReadMe')).status).toBe(200)
  expect((await fetch('/api/docs/ReadMe')).status).toBe(404)

  config = resolveHttpConfig({ caseSensitive: false })
  const redirect = await fetch('/api/docs/ReadMe')
  expect(redirect.status).toBe(308)
  expect(redirect.headers.get('location')).toBe('https://example.test/api/Docs/ReadMe')

  config = resolveHttpConfig({ caseSensitive: true })
  expect((await fetch('/api/docs/ReadMe')).status).toBe(404)
  config = resolveHttpConfig({ caseSensitive: false })
  expect(await (await fetch('/api/Docs/ReadMe')).json()).toEqual({ id: 'ReadMe' })
})

it('compiles canonicalization lazily and reuses it across event policy changes', () => {
  let config = resolveHttpConfig({ caseSensitive: true })
  let reads = 0
  const routePath = parseApiFilePath('Docs.[id].get.ts', '/api')!
  const resolve = createRequestPathResolver(
    [
      {
        get routePath() {
          reads++
          return routePath
        },
      },
    ],
    () => config,
  )
  const request = new Request('https://example.test/api/docs/ReadMe')
  expect(resolve(request)).toBe('/api/docs/ReadMe')
  expect(reads).toBe(0)
  config = resolveHttpConfig({ caseSensitive: false })
  expect(resolve(request)).toBe('/api/Docs/ReadMe')
  expect(reads).toBeGreaterThan(0)
  const compiledReads = reads
  config = resolveHttpConfig({ caseSensitive: true })
  expect(resolve(request)).toBe('/api/docs/ReadMe')
  config = resolveHttpConfig({ caseSensitive: false })
  expect(resolve(request)).toBe('/api/Docs/ReadMe')
  expect(reads).toBe(compiledReads)
})
