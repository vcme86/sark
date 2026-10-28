import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, it } from 'vitest'

import { generateBuildArtifacts } from '../../src/tooling/build/generate'

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

    expect(() =>
      generateBuildArtifacts({
        generatedDir: join(root, '.build'),
        appEntryPath: join(root, 'app.ts'),
        appExports: {
          exports: ['app', 'metrics'],
        },
        routes: [],
        apiPrefix: '/api',
        webPrefix: '/',
        target: 'cloudflare',
      }),
    ).toThrowError(/Cloudflare Workers target does not support Node metrics/)
  })
})

it('generates .build/worker.ts for Cloudflare target without Node runtime imports', () => {
  withTempDir((root) => {
    const generatedDir = join(root, '.build')
    generateBuildArtifacts({
      generatedDir,
      appEntryPath: join(root, 'app.ts'),
      appExports: {
        exports: ['app'],
      },
      routes: [],
      apiPrefix: '/api',
      webPrefix: '/',
      target: 'cloudflare',
    })

    expect(existsSync(join(generatedDir, 'worker.ts'))).toBe(true)
    expect(existsSync(join(generatedDir, 'start.ts'))).toBe(false)

    const workerSource = readFileSync(join(generatedDir, 'worker.ts'), 'utf8')
    expect(workerSource).toContain('@olivaw/sark/runtime/cloudflare')
    expect(workerSource).toContain('createWorkerHandler(definition, import.meta.env.PROD)')
    expect(workerSource).toContain('export default {')
    expect(workerSource).not.toContain('@olivaw/sark/runtime/node')
    expect(workerSource).not.toContain('node:')
  })
})

it('generates .build/start.ts for Node target without Workers runtime imports', () => {
  withTempDir((root) => {
    const generatedDir = join(root, '.build')
    generateBuildArtifacts({
      generatedDir,
      appEntryPath: join(root, 'app.ts'),
      appExports: {
        exports: ['app'],
      },
      routes: [],
      apiPrefix: '/api',
      webPrefix: '/',
      target: 'node',
    })

    expect(existsSync(join(generatedDir, 'start.ts'))).toBe(true)
    expect(existsSync(join(generatedDir, 'worker.ts'))).toBe(false)

    const startSource = readFileSync(join(generatedDir, 'start.ts'), 'utf8')
    expect(startSource).toContain('@olivaw/sark/runtime/node')
    expect(startSource).not.toContain('@olivaw/sark/runtime/cloudflare')
  })
})
