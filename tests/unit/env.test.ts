import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, it } from 'vitest'

import { loadNodeEnv } from '../../src/adapter/node/env'

it('loads file precedence while preserving existing process values', () => {
  const root = mkdtempSync(join(tmpdir(), 'sark-env-'))
  try {
    writeFileSync(join(root, '.env'), 'VALUE=base\nEXISTING=file\nBASE=present')
    writeFileSync(join(root, '.env.local'), 'VALUE=local')
    writeFileSync(join(root, '.env.production'), 'VALUE=mode')
    writeFileSync(join(root, '.env.production.local'), 'VALUE=mode-local')
    const env: NodeJS.ProcessEnv = { EXISTING: 'process' }
    loadNodeEnv(root, env)
    expect(env).toEqual({
      VALUE: 'mode-local',
      EXISTING: 'process',
      BASE: 'present',
      NODE_ENV: 'production',
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('reports an existing environment file that cannot be read as a file', () => {
  const root = mkdtempSync(join(tmpdir(), 'sark-env-'))
  try {
    mkdirSync(join(root, '.env'))
    expect(() => loadNodeEnv(root, {})).toThrow(
      `Failed to load environment file ${join(root, '.env')}`,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
