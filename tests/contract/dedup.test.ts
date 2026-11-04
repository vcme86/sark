import { describe, expect, it } from 'vitest'

import type { RouteDeclaration } from '../../src/app/http/types'
import { createApp, dedup, route } from '../../src/entries/root'
import { createDefinition } from '../../src/entries/runtime/core'
import { parseApiFilePath } from '../../src/http/path'
import { executeRequest, routeEntry } from '../helpers/http-app'

const entry = (file: string, declaration: RouteDeclaration) => ({
  routePath: parseApiFilePath(file, '/api')!,
  declaration,
})

it('dedup distinguishes argument lengths and references and resets between requests', async () => {
  let calls = 0
  const load = dedup(async (..._args: unknown[]) => ++calls)
  const object = {},
    array: unknown[] = []
  const app = await createApp(
    createDefinition({
      routes: [
        entry(
          'dedup.get.ts',
          route().handler(() =>
            Promise.all([
              load(),
              load(),
              load(undefined),
              load(object),
              load(object),
              load({}),
              load(array),
              load(array),
              load([]),
            ]),
          ),
        ),
      ],
    }),
  )
  try {
    const first = await (await app.fetch(new Request('http://localhost/api/dedup'))).json()
    expect(first).toEqual([1, 1, 2, 3, 3, 4, 5, 5, 6])
    await app.fetch(new Request('http://localhost/api/dedup'))
    expect(calls).toBe(12)
  } finally {
    await app.close()
  }
})

describe('request dedup', () => {
  it('dedup compares every argument in multi-argument calls', async () => {
    const fn = dedup(async (a: string, b: string) => `${a}:${b}`)
    const r = route().handler(async () => [await fn('user', 'one'), await fn('user', 'two')])
    const e = routeEntry('/api/read', r)
    const res = await executeRequest({}, e, new Request('http://localhost/api/read'))
    const values = await res.json()
    expect(values).toEqual(['user:one', 'user:two'])
  })
})
