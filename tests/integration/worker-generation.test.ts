import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

it('validates Wrangler triggers.crons against declared Cloudflare jobs during generation', () => {
  withTempDir((root) => {
    const generatedDir = join(root, '.build')
    const appEntryPath = join(root, 'app.ts')

    // 1. Exporting jobs without triggers.crons throws
    writeFileSync(
      appEntryPath,
      `import { defineJobs } from '@olivaw/sark/jobs'
export const jobs = defineJobs([{ name: 'test', onCron: '0 * * * *', handler: async () => {} }])`,
    )
    expect(() =>
      generateProject(root, { target: 'cloudflare', apiDir: false, webDir: false }),
    ).toThrowError(/Cloudflare Workers target requires triggers.crons in Wrangler configuration/)

    // 2. Having triggers.crons in wrangler.jsonc but no jobs exported throws
    writeFileSync(
      join(root, 'wrangler.jsonc'),
      JSON.stringify({
        triggers: { crons: ['0 * * * *'] },
      }),
    )
    writeFileSync(appEntryPath, 'export const app = {}')
    expect(() =>
      generateProject(root, { target: 'cloudflare', apiDir: false, webDir: false }),
    ).toThrowError(/Wrangler triggers.crons specifies scheduled crons, but no "jobs" declaration/)

    // 3. Mismatched cron (job specifies cron not in triggers.crons) throws
    writeFileSync(
      appEntryPath,
      `import { defineJobs } from '@olivaw/sark/jobs'
export const jobs = defineJobs([{ name: 'test', onCron: '0 0 * * *', handler: async () => {} }])`,
    )
    expect(() =>
      generateProject(root, { target: 'cloudflare', apiDir: false, webDir: false }),
    ).toThrowError(/which is not declared in Wrangler triggers.crons/)

    // 4. Missing job for trigger in wrangler.jsonc throws
    writeFileSync(
      join(root, 'wrangler.jsonc'),
      JSON.stringify({
        triggers: { crons: ['0 * * * *', '0 12 * * *'] },
      }),
    )
    writeFileSync(
      appEntryPath,
      `import { defineJobs } from '@olivaw/sark/jobs'
export const jobs = defineJobs([{ name: 'test', onCron: '0 * * * *', handler: async () => {} }])`,
    )
    expect(() =>
      generateProject(root, { target: 'cloudflare', apiDir: false, webDir: false }),
    ).toThrowError(/which has no matching scheduled job declared/)

    // 5. Successful match generates worker.ts with scheduled handler and triggers in app.ts
    writeFileSync(
      join(root, 'wrangler.jsonc'),
      JSON.stringify({
        triggers: { crons: ['0 * * * *'] },
      }),
    )
    generateProject(root, { target: 'cloudflare', apiDir: false, webDir: false })

    const workerSource = readFileSync(join(generatedDir, 'worker.ts'), 'utf8')
    expect(workerSource).toContain('scheduled(controller: ScheduledController')

    const appSource = readFileSync(join(generatedDir, 'app.ts'), 'utf8')
    expect(appSource).toContain('triggers: { crons: ["0 * * * *"] }')
  })
})
