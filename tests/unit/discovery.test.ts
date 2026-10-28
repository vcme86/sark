import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, it } from 'vitest'

import { discoverAppEntry } from '../../src/tooling/build/discover/app'
import { discoverPages } from '../../src/tooling/build/discover/pages'
import { discoverApiRoutes } from '../../src/tooling/build/discover/routes'

it('rejects middleware syntax errors at discovery with the source file identified', () => {
  const root = mkdtempSync(join(tmpdir(), 'sark-discovery-'))
  try {
    const middleware = join(root, '_middleware.ts')
    writeFileSync(middleware, 'export default (')
    expect(() => discoverApiRoutes(root, '/api')).toThrow(middleware)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it.each(['directory', 'dotted'])(
  'preserves intermediate index directories and group ancestry in %s routes',
  (format) => {
    const root = mkdtempSync(join(tmpdir(), 'sark-index-discovery-'))
    const name = (path: string) => (format === 'dotted' ? path.replaceAll('/', '.') : path)
    const write = (tree: string, path: string, source: string) => {
      const fullPath = join(root, tree, name(path))
      mkdirSync(join(fullPath, '..'), { recursive: true })
      writeFileSync(fullPath, source)
    }
    try {
      for (const tree of ['api', 'app']) {
        write(tree, '(content)/users/_middleware.ts', 'export const scope = {}')
        write(tree, '(content)/users/index/_middleware.ts', 'export const scope = {}')
      }
      write('api', '(content)/users/index.get.ts', 'export default {}')
      write('api', '(content)/users/index/posts.get.ts', 'export default {}')
      write('app', '(content)/users/index.tsx', 'export default () => null')
      write('app', '(content)/users/index/posts.tsx', 'export default () => null')
      const api = discoverApiRoutes(join(root, 'api'), '/api')
      const pages = discoverPages(join(root, 'app'), '/')
      expect(api.map((entry) => entry.routePath.urlPath)).toEqual([
        '/api/users',
        '/api/users/index/posts',
      ])
      expect(pages.pages.map((entry) => entry.routePath.urlPath)).toEqual([
        '/users',
        '/users/index/posts',
      ])
      expect(api.map((entry) => entry.ancestorMiddlewares.map((mw) => mw.scopeKey))).toEqual([
        ['(content)/users'],
        ['(content)/users', '(content)/users/index'],
      ])
      expect(pages.pages.map((entry) => entry.middlewareChain.map((mw) => mw.scopeKey))).toEqual([
        ['(content)/users'],
        ['(content)/users', '(content)/users/index'],
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)

it('ignores helper segments consistently in dotted and directory API routes', () => {
  const root = mkdtempSync(join(tmpdir(), 'sark-discovery-'))
  try {
    mkdirSync(join(root, 'posts', '_helpers'), { recursive: true })
    writeFileSync(join(root, 'posts', '_helpers', 'hidden.get.ts'), 'export default {}')
    writeFileSync(join(root, 'posts._helpers.hidden.get.ts'), 'export default {}')
    writeFileSync(join(root, 'posts.get.ts'), 'export default {}')
    writeFileSync(join(root, 'posts._middleware.ts'), 'export const scope = {}')
    const routes = discoverApiRoutes(root, '/api')
    expect(routes.map((entry) => entry.relativePath)).toEqual(['posts.get.ts'])
    expect(routes[0].ancestorMiddlewares.map((entry) => entry.relativePath)).toEqual([
      'posts._middleware.ts',
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it.each([
  "export type { Env } from './types'; export const app = {}",
  "export { type Env, app } from './types'",
  "export type * from './types'; export const app = {}",
])('ignores type-only exports in %s', (source) => {
  const root = mkdtempSync(join(tmpdir(), 'sark-discovery-'))
  try {
    writeFileSync(join(root, 'app.ts'), source)
    writeFileSync(
      join(root, 'types.ts'),
      'export type Env = NodeJS.ProcessEnv; export const app = {}',
    )
    expect(discoverAppEntry(join(root, 'app.ts'))).toEqual({
      exports: ['app'],
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
