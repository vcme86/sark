import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BuildEnvironment, createIdResolver, resolveConfig } from 'vite'
import { describe, expect, it } from 'vitest'

import { discoverAppEntry, discoverDatabaseDriver } from '../../src/tooling/build/discover/app'
import { generateBuildArtifacts } from '../../src/tooling/build/generate'

describe('Database & Resource Assembly Contract', () => {
  describe('Platform Boundary & Target Diagnostics', () => {
    it('diagnoses target mismatch during build-time generation', () => {
      const targetDir = join(
        tmpdir(),
        `sark-gen-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      )

      // Cloudflare target with SQLite driver
      expect(() => {
        generateBuildArtifacts({
          generatedDir: targetDir,
          appEntryPath: '/virtual/app.ts',
          appExports: {
            exports: ['app', 'database'],
            databaseDriver: 'sqlite',
          },
          routes: [],
          apiPrefix: '/api',
          webPrefix: '/',
          target: 'cloudflare',
        })
      }).toThrow(/Cloudflare Workers target does not support Node.js database driver/i)

      // Node target with D1 driver
      expect(() => {
        generateBuildArtifacts({
          generatedDir: targetDir,
          appEntryPath: '/virtual/app.ts',
          appExports: {
            exports: ['app', 'database'],
            databaseDriver: 'd1',
          },
          routes: [],
          apiPrefix: '/api',
          webPrefix: '/',
          target: 'node',
        })
      }).toThrow(/Node.js target does not support Cloudflare D1 database driver/i)
    })

    it('discovers database driver from import syntax and follows relative re-exports', async () => {
      const testDir = join(
        tmpdir(),
        `sark-discover-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      )
      const appFile = join(testDir, 'app.ts')
      const dbFile = join(testDir, 'database.ts')
      const genDir = join(testDir, '.build')

      try {
        mkdirSync(testDir, { recursive: true })
        // database.ts defines the database
        writeFileSync(
          dbFile,
          `import { defineDatabase } from '@olivaw/sark/db/sqlite'
export const database = defineDatabase({ filename: ':memory:' })
`,
        )
        // app.ts re-exports it
        writeFileSync(appFile, `export { database } from './database'\n`)

        const discovered = discoverAppEntry(appFile)
        const viteConfig = await resolveConfig(
          { root: testDir, configFile: false, logLevel: 'silent', environments: { ssr: {} } },
          'build',
        )
        const resolveId = createIdResolver(viteConfig)
        const environment = new BuildEnvironment('ssr', viteConfig)
        discovered.databaseDriver = await discoverDatabaseDriver(appFile, (id, importer) =>
          resolveId(environment, id, importer),
        )
        expect(discovered.exports).toContain('database')
        expect(discovered.databaseDriver).toBe('sqlite')

        // Pure schema or type imports do not enable driver
        const nonDbFile = join(testDir, 'non-db-app.ts')
        writeFileSync(
          nonDbFile,
          `import type { SqliteConfig } from '@olivaw/sark/db/sqlite'
export const database = { dummy: true }
`,
        )
        const nonDbDiscovered = discoverAppEntry(nonDbFile)
        expect(nonDbDiscovered.databaseDriver).toBeUndefined()

        generateBuildArtifacts({
          generatedDir: genDir,
          appEntryPath: appFile,
          appExports: discovered,
          routes: [],
          apiPrefix: '/api',
          webPrefix: '/',
          target: 'node',
        })

        // Check resources-types.ts content
        const resourcesCode = readFileSync(join(genDir, 'resources-types.ts'), 'utf-8')
        expect(resourcesCode).toContain('export type Db = InferResource<typeof database>')
        expect(resourcesCode).toContain('readonly db: Db')

        const typesDtsCode = readFileSync(join(genDir, 'types.d.ts'), 'utf-8')
        expect(typesDtsCode).toContain('resources: Resources')
        expect(typesDtsCode).toContain("declare module '@olivaw/sark'")
      } finally {
        rmSync(testDir, { recursive: true, force: true })
      }
    })
  })
})
