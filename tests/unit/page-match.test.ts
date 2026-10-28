import { expect, it } from 'vitest'

import { matchClientRoute, matchPattern } from '../../src/page/match'

it('retains candidate priority and decodes parameters after earlier mismatches', () => {
  const routes = [
    { pattern: '/elsewhere/:id', paramNames: ['id'] },
    { pattern: '/posts/trending', paramNames: [] },
    { pattern: '/posts/:id', paramNames: ['id'] },
    { pattern: '/posts/*', paramNames: ['path'] },
  ]
  expect(matchClientRoute(routes, '/posts/trending')).toEqual({ route: routes[1], params: {} })
  expect(matchClientRoute(routes, '/posts/a%2Fb')).toEqual({
    route: routes[2],
    params: { id: 'a/b' },
  })
  expect(matchClientRoute(routes, '/posts/2026/%E4%B8%AD%E6%96%87')).toEqual({
    route: routes[3],
    params: { path: ['2026', '中文'] },
  })
})

it.each([
  {
    pattern: '/中文/:id',
    path: '/%E4%B8%AD%E6%96%87/a%20b',
    names: ['id'],
    sensitive: true,
    params: { id: 'a b' },
  },
  {
    pattern: '/Docs/:id',
    path: '/docs/ReadMe',
    names: ['id'],
    sensitive: false,
    params: { id: 'ReadMe' },
  },
  { pattern: '/Docs/:id', path: '/docs/ReadMe', names: ['id'], sensitive: true, params: null },
  { pattern: '/posts/:id', path: '/posts/%E0%A4', names: ['id'], sensitive: true, params: null },
  { pattern: '/posts/*', path: '/posts/%ZZ/x', names: ['path'], sensitive: true, params: null },
  { pattern: '/posts/*', path: '/posts/', names: ['path'], sensitive: true, params: { path: [] } },
])(
  'matches $path against $pattern without changing decoding or casing',
  ({ pattern, path, names, sensitive, params }) => {
    expect(matchPattern(pattern, path, names, sensitive)).toEqual(params)
    const route = { pattern, paramNames: names }
    expect(matchClientRoute([route], path, sensitive)).toEqual(
      params === null ? null : { route, params },
    )
  },
)

it('keeps exact static matches, roots and empty tables valid', () => {
  const root = { pattern: '/', paramNames: [] }
  expect(matchClientRoute([root], '/')).toEqual({ route: root, params: {} })
  expect(matchClientRoute([], '/')).toBeNull()
  expect(matchClientRoute([root], '/missing')).toBeNull()
})
