import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, it } from 'vitest'

import { discoverAppEntry } from '../../src/tooling/build/discover/app'
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
      hasApp: true,
      hasRuntime: false,
      exports: ['app'],
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
