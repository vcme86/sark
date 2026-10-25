import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, it } from 'vitest'

import { discoverAppEntry } from '../../src/tooling/build/discover/app'

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
