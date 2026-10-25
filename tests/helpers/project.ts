import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { dirname, join, resolve } from 'node:path'

export const projectRoot = resolve('.')
export const cliEntry = join(projectRoot, 'dist/tooling/cli/index.mjs')
export const viteEntry = join(projectRoot, 'dist/entries/vite.mjs')

/** Creates an isolated application that resolves the repository's built package exports. */
export function createProject() {
  const root = mkdtempSync(join(projectRoot, 'tests/fixtures/application-'))
  return {
    root,
    write(path: string, source: string) {
      const fullPath = join(root, path)
      mkdirSync(dirname(fullPath), { recursive: true })
      writeFileSync(fullPath, source)
    },
    remove() {
      rmSync(root, { recursive: true, force: true })
    },
  }
}

export function serverUrl(server: Pick<Server, 'address'> | null): string {
  const address = server?.address()
  if (!address || typeof address === 'string') throw new Error('Expected a listening TCP server')
  return `http://127.0.0.1:${address.port}`
}

/** Runs the built CLI in a child process without changing the test worker's cwd or environment. */
export function runProjectCli(root: string, args: string[], env?: NodeJS.ProcessEnv) {
  const result = spawnSync(process.execPath, [cliEntry, ...args], {
    cwd: root,
    env: env ? { ...process.env, ...env } : process.env,
    encoding: 'utf8',
    timeout: 30000,
  })
  if (result.error) throw result.error
  return result
}
