import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'

import { expect, it } from 'vitest'

import { createProject, runProjectCli } from '../helpers/project'

const cli = resolve('dist/tooling/cli/index.mjs')
const viteEntry = resolve('dist/entries/vite.mjs')

function withProject(run: (root: string) => void): void {
  mkdirSync('.build', { recursive: true })
  const root = mkdtempSync(resolve('.build/cli-'))
  try {
    run(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function generate(root: string) {
  const result = spawnSync(process.execPath, [cli, 'generate'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 10000,
  })
  if (result.error) throw result.error
  return result
}

it('generates from the resolved Vite root and Sark options without executing the application', () => {
  withProject((root) => {
    const appRoot = join(root, 'application')
    mkdirSync(join(appRoot, 'handlers'), { recursive: true })
    writeFileSync(
      join(appRoot, 'definition.ts'),
      `import { defineApp } from '@olivaw/sark/server'
export const app = defineApp((_env: NodeJS.ProcessEnv) => {
  throw new Error('Generation must not evaluate the application factory')
})`,
    )
    writeFileSync(
      join(appRoot, 'handlers/books.get.ts'),
      "import { route } from '@olivaw/sark/server'; export default route().handler(() => ['book'])",
    )
    const reads = join(root, 'config-reads.txt')
    writeFileSync(
      join(root, 'vite.config.mts'),
      `import { appendFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import { sark } from ${JSON.stringify(viteEntry)}
export default defineConfig(async ({ command, mode }) => {
  appendFileSync(${JSON.stringify(reads)}, command + ':' + mode + '\\n')
  return {
    root: './application',
    logLevel: 'silent',
    plugins: [Promise.resolve([sark({
      appEntry: 'definition.ts', apiDir: 'handlers', generatedDir: 'generated/api',
      apiPrefix: mode === 'production' ? '/service/v3' : '/unexpected-mode',
    })])],
  }
})`,
    )
    const result = generate(root)
    expect(result.status, result.stdout + result.stderr).toBe(0)
    const definition = readFileSync(join(appRoot, 'generated/api/app.ts'), 'utf8')
    expect(definition).toContain('from "../../definition"')
    expect(definition).toContain('from "../../handlers/books.get"')
    expect(definition).toContain('"urlPath":"/service/v3/books"')
    expect(definition).toContain('"/books": {')
    expect(readFileSync(join(appRoot, 'generated/api/start.ts'), 'utf8')).toContain(
      'await startNodeServer(instance, runtime, process.env, { rootDir:',
    )
    expect(readFileSync(reads, 'utf8')).toBe('build:production\n')
    expect(existsSync(join(root, '.build'))).toBe(false)
    expect(existsSync(join(appRoot, '.build'))).toBe(false)
  })
})

it('honors apiDir: false instead of scanning the default API directory', () => {
  withProject((root) => {
    mkdirSync(join(root, 'api'))
    writeFileSync(
      join(root, 'api/private.get.ts'),
      "import { route } from '@olivaw/sark/server'; export default route().handler(() => 'private')",
    )
    writeFileSync(
      join(root, 'vite.config.mts'),
      `import { sark } from ${JSON.stringify(viteEntry)}
export default { logLevel: 'silent', plugins: [sark({ apiDir: false, generatedDir: 'generated' })] }`,
    )
    const result = generate(root)
    expect(result.status, result.stdout + result.stderr).toBe(0)
    const definition = readFileSync(join(root, 'generated/app.ts'), 'utf8')
    expect(definition).not.toContain('private')
    expect(definition).toMatch(/routes:\s*\[\s*\]/)
    expect(existsSync(join(root, '.build'))).toBe(false)
  })
})

it.each([false, true])('uses shared defaults without a Sark plugin (Vite config=%s)', (config) => {
  withProject((root) => {
    const appRoot = config ? join(root, 'application') : root
    mkdirSync(join(appRoot, 'api'), { recursive: true })
    writeFileSync(
      join(appRoot, 'app.ts'),
      "import { defineApp } from '@olivaw/sark/server'; export const app = defineApp({})",
    )
    writeFileSync(
      join(appRoot, 'api/ping.get.ts'),
      "import { route } from '@olivaw/sark/server'; export default route().handler(() => 'pong')",
    )
    if (config) {
      writeFileSync(
        join(root, 'vite.config.mts'),
        "export default { root: './application', logLevel: 'silent' }",
      )
    }
    const result = generate(root)
    expect(result.status, result.stdout + result.stderr).toBe(0)
    const definition = readFileSync(join(appRoot, '.build/app.ts'), 'utf8')
    expect(definition).toContain('from "../app"')
    expect(definition).toContain('"urlPath":"/api/ping"')
    expect(definition).toContain('"/ping": {')
    expect(existsSync(join(appRoot, '.build/start.ts'))).toBe(true)
  })
})

it('reports Vite configuration failures instead of silently generating with defaults', () => {
  withProject((root) => {
    writeFileSync(
      join(root, 'vite.config.mts'),
      "export default () => { throw new Error('Invalid project configuration') }",
    )
    const result = generate(root)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Invalid project configuration')
    expect(existsSync(join(root, '.build'))).toBe(false)
  })
})

it('reports an error when starting production server without built artifacts', () => {
  withProject((root) => {
    const result = spawnSync(process.execPath, [cli, 'start'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 10000,
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Production entry "dist/server.mjs" not found')
  })
})

it('builds and starts a production application with custom entry, route, generated and output paths', async () => {
  const project = createProject()
  project.write(
    'site.ts',
    `import { defineApp } from '@olivaw/sark/server'
export const app = defineApp({ headers: { 'X-Mode': process.env.NODE_ENV! } })`,
  )
  project.write(
    'handlers/hello.get.ts',
    `import { route } from '@olivaw/sark/server'
export default route().handler(() => ({ custom: 'route' }))`,
  )
  project.write(
    'vite.config.mts',
    `import { appendFileSync } from 'node:fs'
import { sark } from ${JSON.stringify(viteEntry)}
export default () => {
  appendFileSync(${JSON.stringify(join(project.root, 'config-reads.txt'))}, 'build\\n')
  return { logLevel: 'silent', plugins: [sark({ appEntry: 'site.ts', apiDir: 'handlers',
apiPrefix: '/v3', generatedDir: 'generated' })], build: { outDir: 'output' } }
}`,
  )
  try {
    const result = runProjectCli(project.root, ['build'])
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(readFileSync(join(project.root, 'config-reads.txt'), 'utf8')).toBe('build\n')
    expect(existsSync(join(project.root, 'output/server.mjs'))).toBe(true)
    expect(existsSync(join(project.root, 'dist/server.mjs'))).toBe(false)
    expect(existsSync(join(project.root, 'generated/start.ts'))).toBe(true)

    const socket = createServer()
    await new Promise<void>((ready, reject) => {
      socket.once('error', reject)
      socket.listen(0, '127.0.0.1', ready)
    })
    const address = socket.address()
    if (!address || typeof address === 'string') throw new Error('Missing ephemeral port')
    const port = address.port
    await new Promise<void>((closed) => socket.close(() => closed()))
    const child = spawn(process.execPath, [cli, 'start', 'output/server.mjs'], {
      cwd: project.root,
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const exited = once(child, 'exit')
    let diagnostics = ''
    child.stdout.on('data', (chunk) => {
      diagnostics += chunk
    })
    child.stderr.on('data', (chunk) => {
      diagnostics += chunk
    })
    try {
      await expect
        .poll(async () => {
          if (child.exitCode !== null) throw new Error(`Server exited: ${diagnostics}`)
          try {
            const response = await fetch(`http://127.0.0.1:${port}/v3/hello`)
            return {
              status: response.status,
              mode: response.headers.get('X-Mode'),
              body: await response.json(),
            }
          } catch (error) {
            if (error instanceof TypeError && error.cause) return null
            throw error
          }
        })
        .toEqual({ status: 200, mode: 'production', body: { custom: 'route' } })
      expect((await fetch(`http://127.0.0.1:${port}/api/hello`)).status).toBe(404)
    } finally {
      child.kill('SIGTERM')
      await exited
    }
  } finally {
    project.remove()
  }
}, 15000)

it('builds fullstack pages retaining dist/manifest.json alongside dist/server.mjs', async () => {
  const project = createProject()
  project.write(
    'app.ts',
    `import { defineApp } from '@olivaw/sark/server'
export const app = defineApp({})`,
  )
  project.write(
    'app/index.tsx',
    `import React from 'react'
export default function Home() { return <h1>Home</h1> }`,
  )
  project.write(
    'vite.config.mts',
    `import { sark } from ${JSON.stringify(viteEntry)}
export default { logLevel: 'silent', plugins: [sark()] }`,
  )
  try {
    const result = runProjectCli(project.root, ['build'])
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(existsSync(join(project.root, 'dist/server.mjs'))).toBe(true)
    expect(existsSync(join(project.root, 'dist/manifest.json'))).toBe(true)
  } finally {
    project.remove()
  }
}, 20000)

it('cleans and builds relative to the final Vite root without touching the invoking directory output', () => {
  const project = createProject()
  try {
    project.write('dist/keep.txt', 'unrelated invoking-directory output')
    project.write('application/dist/stale.txt', 'previous application output')
    project.write('application/app.ts', '')
    project.write(
      'application/app/index.tsx',
      'export default function Page() { return <h1>Home</h1> }',
    )
    project.write(
      'vite.config.mts',
      `import { sark } from ${JSON.stringify(viteEntry)}
export default { root: './application', logLevel: 'silent', plugins: [sark()] }`,
    )
    const result = runProjectCli(project.root, ['build'])
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(readFileSync(join(project.root, 'dist/keep.txt'), 'utf8')).toBe(
      'unrelated invoking-directory output',
    )
    expect(existsSync(join(project.root, 'application/dist/stale.txt'))).toBe(false)
    expect(existsSync(join(project.root, 'application/dist/server.mjs'))).toBe(true)
    expect(existsSync(join(project.root, 'application/dist/manifest.json'))).toBe(true)
  } finally {
    project.remove()
  }
}, 20000)

it('preserves existing files in outDir when outDir is outside project root and emptyOutDir is unspecified', async () => {
  const project = createProject()
  const externalOut = join(project.root, '../isolated-dist-' + Math.random().toString(36).slice(2))
  mkdirSync(externalOut, { recursive: true })
  writeFileSync(join(externalOut, 'keep.txt'), 'do-not-delete')

  project.write(
    'app.ts',
    `import { defineApp } from '@olivaw/sark/server'
export const app = defineApp({})`,
  )
  project.write(
    'app/index.tsx',
    `import React from 'react'
export default function Home() { return <h1>Home</h1> }`,
  )
  project.write(
    'vite.config.mts',
    `import { sark } from ${JSON.stringify(viteEntry)}
export default { logLevel: 'silent', plugins: [sark()], build: { outDir: ${JSON.stringify(externalOut)} } }`,
  )
  try {
    const result = runProjectCli(project.root, ['build'])
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(existsSync(join(externalOut, 'server.mjs'))).toBe(true)
    expect(existsSync(join(externalOut, 'keep.txt'))).toBe(true)
  } finally {
    rmSync(externalOut, { recursive: true, force: true })
    project.remove()
  }
}, 20000)
