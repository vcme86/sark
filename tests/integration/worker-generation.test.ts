import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, it } from 'vitest'

import { generateBuildArtifacts } from '../../src/tooling/build/generate'
import { generateProject } from '../../src/tooling/build/project'

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'sark-worker-test-'))
  try {
    run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

it('enforces platform boundary by rejecting Node runtime declarations for Cloudflare target', () => {
  withTempDir((root) => {
    expect(() =>
      generateBuildArtifacts({
        generatedDir: join(root, '.build'),
        appEntryPath: join(root, 'app.ts'),
        appExports: {
          exports: ['app', 'runtime'],
        },
        routes: [],
        apiPrefix: '/api',
        webPrefix: '/',
        target: 'cloudflare',
      }),
    ).toThrowError(/Cloudflare Workers target does not support Node runtime configuration/)

    expect(() =>
      generateBuildArtifacts({
        generatedDir: join(root, '.build'),
        appEntryPath: join(root, 'app.ts'),
        appExports: {
          exports: ['app', 'health'],
        },
        routes: [],
        apiPrefix: '/api',
        webPrefix: '/',
        target: 'cloudflare',
      }),
    ).toThrowError(/Cloudflare Workers target does not support Node health probes/)
  })
})

it.each(['node', 'cloudflare'] as const)(
  'rejects unimplemented capabilities during %s discovery',
  (target) => {
    withTempDir((root) => {
      writeFileSync(join(root, 'app.ts'), 'export const stats = {}')
      expect(() => generateProject(root, { target, apiDir: false, webDir: false })).toThrow('stats')
    })
  },
)
