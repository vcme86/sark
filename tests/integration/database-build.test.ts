import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { resolveConfig } from 'vite'
import { expect, it } from 'vitest'

import { sark } from '../../src/tooling/vite'
import { createProject, runProjectCli } from '../helpers/project'

it.each([
  [
    'direct namespace import',
    `import * as driver from '@olivaw/sark/db/sqlite'
export const database = driver.defineDatabase(() => { throw new Error('Build must not execute factories') })`,
  ],
  [
    'namespace and constructor aliases',
    `import * as sqlite from '@olivaw/sark/db/sqlite'
const selected = sqlite
const define = selected['defineDatabase']
export const database = define({ filename: ':memory:' })`,
  ],
  [
    'local namespace and namespace re-export',
    `import * as local from './driver'
export const database = local.sqlite.defineDatabase({ filename: ':memory:' })`,
  ],
])('diagnoses namespace driver targets through %s', async (_name, source) => {
  const project = createProject()
  project.write('app.ts', source)
  project.write('driver.ts', `export * as sqlite from '@olivaw/sark/db/sqlite'`)
  try {
    const config = {
      root: project.root,
      configFile: false as const,
      logLevel: 'silent' as const,
    }
    await expect(
      resolveConfig({ ...config, plugins: [sark({ target: 'cloudflare' })] }, 'build'),
    ).rejects.toThrow('Node.js database driver')
    await resolveConfig({ ...config, plugins: [sark({ target: 'node' })] }, 'build')
  } finally {
    project.remove()
  }
})

it('resolves Vite aliases and constructor re-exports without executing configuration factories', async () => {
  const project = createProject()
  project.write('driver.ts', `export {defineDatabase as defineStore} from '@olivaw/sark/db/sqlite'`)
  project.write(
    'database.ts',
    `import {defineStore} from '@driver'
export const selected = defineStore((_env: unknown) => { throw new Error('Do not execute configuration at build time') })`,
  )
  project.write('app.ts', `export {selected as database} from '@database'`)
  const alias = {
    '@driver': join(project.root, 'driver.ts'),
    '@database': join(project.root, 'database.ts'),
  }
  try {
    await expect(
      resolveConfig(
        {
          root: project.root,
          configFile: false,
          logLevel: 'silent',
          resolve: { alias },
          plugins: [sark({ target: 'cloudflare' })],
        },
        'build',
      ).then(() => undefined),
    ).rejects.toThrow('Node.js database driver')
    await resolveConfig(
      {
        root: project.root,
        configFile: false,
        logLevel: 'silent',
        resolve: { alias },
        plugins: [sark({ target: 'node' })],
      },
      'build',
    )
    expect(readFileSync(join(project.root, '.build/app.ts'), 'utf8')).toContain(
      'resources: { db: database }',
    )
    project.write('vite.config.mts', `export default {resolve: {alias: ${JSON.stringify(alias)}}}`)
    const generated = runProjectCli(project.root, ['generate'])
    expect(generated.status, generated.stdout + generated.stderr).toBe(0)

    project.write(
      'app.ts',
      `import type {SqliteConfig} from '@olivaw/sark/db/sqlite'
export const app = undefined`,
    )
    await resolveConfig(
      {
        root: project.root,
        configFile: false,
        logLevel: 'silent',
        resolve: { alias },
        plugins: [sark({ target: 'cloudflare' })],
      },
      'build',
    )
  } finally {
    project.remove()
  }
})

/** Collects actual external dependencies of the framework's emitted type graph. */
function declarationDependencies(entry: string) {
  const visited = new Set<string>()
  const external = new Set<string>()
  function visit(file: string) {
    if (visited.has(file)) return
    visited.add(file)
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(/\b(?:from\s*|import\s*(?:\(\s*)?)["']([^"']+)["']/g)) {
      const specifier = match[1]
      if (specifier.startsWith('.'))
        visit(resolve(dirname(file), specifier.replace(/\.mjs$/, '.d.mts')))
      else external.add(specifier)
    }
  }
  const manifest = JSON.parse(readFileSync(resolve('package.json'), 'utf8'))
  visit(resolve(manifest.exports[entry === '.' ? '.' : './' + entry].types))
  return external
}

it('keeps unselected SDKs out of each built declaration graph', () => {
  for (const [entry, forbidden] of [
    ['.', ['drizzle-orm', 'postgres', 'better-sqlite3', '@cloudflare/workers-types']],
    [
      'db/sqlite',
      ['drizzle-orm/postgres-js', 'drizzle-orm/d1', 'postgres', '@cloudflare/workers-types'],
    ],
    [
      'db/postgres',
      [
        'drizzle-orm/better-sqlite3',
        'drizzle-orm/d1',
        'better-sqlite3',
        '@cloudflare/workers-types',
      ],
    ],
    [
      'db/d1',
      ['drizzle-orm/better-sqlite3', 'drizzle-orm/postgres-js', 'better-sqlite3', 'postgres'],
    ],
  ] as const) {
    const dependencies = declarationDependencies(entry)
    for (const dependency of dependencies) {
      expect(
        forbidden.some((name) => dependency === name || dependency.startsWith(name + '/')),
        `${entry} unexpectedly depends on ${dependency}`,
      ).toBe(false)
    }
  }
})
