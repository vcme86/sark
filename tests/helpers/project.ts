import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { setTimeout } from 'node:timers/promises'

export const projectRoot = resolve('.')
export const cliEntry = join(projectRoot, 'dist/tooling/cli.mjs')
export const viteEntry = '@olivaw/sark/vite'

/** Creates an isolated application that resolves the repository's built package exports. */
export function createProject() {
  mkdirSync(join(projectRoot, '.build'), { recursive: true })
  const root = mkdtempSync(join(projectRoot, '.build/application-'))
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

/** Starts a built Node application on an OS-assigned port and waits for the listening log. */
export async function startNodeProject(root: string, env?: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [join(root, 'dist/server.mjs')], {
    cwd: root,
    env: { ...process.env, ...env, PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const exited = once(child, 'exit')
  const listening = Promise.withResolvers<string>()
  let output = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    output += chunk
    const port = /Node server listening on port (\d+)[^\n]*\n/.exec(output)?.[1]
    if (port) listening.resolve(`http://127.0.0.1:${port}`)
  })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    output += chunk
  })

  try {
    const origin = await Promise.race([
      listening.promise,
      exited.then(([code]) => {
        throw new Error(`Node application exited before listening (${code}):\n${output}`)
      }),
      setTimeout(10_000, undefined, { ref: false }).then(() => {
        throw new Error(`Node application did not start:\n${output}`)
      }),
    ])
    return {
      origin,
      stop() {
        child.kill('SIGTERM')
        return exited
      },
    }
  } catch (error) {
    child.kill('SIGKILL')
    await exited.catch(() => {})
    throw error
  }
}
