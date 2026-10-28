import { expect, it } from 'vitest'

import { defineNodeRuntime, resolveNodeRuntime } from '../../src/adapter/node/runtime'
import { route, z } from '../../src/entries/server'
import { parseApiFilePath } from '../../src/http/path'
import { acceptsJson } from '../../src/http/server/output'
it('parses standard API file paths correctly', () => {
  const route1 = parseApiFilePath('users.[id].get.ts', '/api')
  expect(route1).not.toBeNull()
  expect(route1?.urlPath).toBe('/api/users/:id')
  expect(route1?.method).toBe('GET')

  const route2 = parseApiFilePath('site[.]webmanifest.get.ts', '/api')
  expect(route2?.urlPath).toBe('/api/site.webmanifest')

  const route3 = parseApiFilePath('(group).posts.[...slug].post.ts', '/api')
  expect(route3?.urlPath).toBe('/api/posts/:slug{.+}?')
  expect(route3?.clientPath).toBe('/api/posts/*slug')
  expect(route3?.method).toBe('POST')

  const route4 = parseApiFilePath('items.index.get.ts', '/api')
  expect(route4?.urlPath).toBe('/api/items')
})

it('rejects creation when mutually exclusive body schemas are declared', () => {
  expect(() => {
    route().validate({
      json: z.object({ a: z.string() }),
      text: z.string(),
    })
  }).toThrow(/Mutually exclusive body schemas declared/)
})

it('evaluates Accept header according to RFC 9110', () => {
  expect(acceptsJson(undefined)).toBe(true)
  expect(acceptsJson('')).toBe(true)
  expect(acceptsJson('application/json')).toBe(true)
  expect(acceptsJson('text/html, */*;q=0.8')).toBe(true)
  expect(acceptsJson('text/html')).toBe(false)
  expect(acceptsJson('application/json;q=0, */*;q=1')).toBe(false)
})

it('resolves port from config, env or default', () => {
  expect(resolveNodeRuntime(defineNodeRuntime({ port: 8080 })).port).toBe(8080)
  expect(resolveNodeRuntime(defineNodeRuntime(), { PORT: '5000' }).port).toBe(5000)
  expect(resolveNodeRuntime(defineNodeRuntime()).port).toBe(3000)
})

it('rejects invalid PORT values', () => {
  expect(() => resolveNodeRuntime(defineNodeRuntime(), { PORT: 'abc' })).toThrow(/Invalid PORT/)
  expect(() => resolveNodeRuntime(defineNodeRuntime({ port: 70000 }))).toThrow(/Invalid port/)
})
