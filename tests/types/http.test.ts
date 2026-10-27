import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { resolveConfig } from 'vite'
import { describe, expect, it } from 'vitest'

import { sark } from '../../src/tooling/vite'

const projectRoot = process.cwd()

async function compileFixture(apiPrefix: string, appSource?: string) {
  mkdirSync(join(projectRoot, '.build'), { recursive: true })
  const root = mkdtempSync(join(projectRoot, '.build/types-'))
  try {
    mkdirSync(join(root, 'api'))
    writeFileSync(
      join(root, 'app.ts'),
      appSource ??
        `
import { defineApp } from '@olivaw/sark/server'
import { defineNodeRuntime } from '@olivaw/sark/server/node'
export const app = defineApp((env: NodeJS.ProcessEnv) => ({ hosts: env.HOST }))
export const runtime = defineNodeRuntime((env: NodeJS.ProcessEnv) => ({ port: Number(env.PORT ?? 0) }))
`,
    )
    writeFileSync(
      join(root, 'api/_middleware.ts'),
      `import { createMiddleware } from 'hono/factory'
export default createMiddleware(async (_ctx, next) => next())
`,
    )
    const routes: Record<string, string> = {
      'files.[...path].get':
        'route().validate({ params: z.object({ path: z.string() }) }).handler((ctx, input) => ({ path: input.params.path, id: ctx.var.requestId }))',
      'search.get':
        'route().validate({ query: z.object({ term: z.string() }) }).handler((_c, input) => input.query)',
      'convert.post':
        'route().validate({ text: z.string().transform(Number) }).handler((_c, input) => ({ value: input.text }))',
      'custom.post': `route().validate({ text: {
        safeParse(value: unknown) { return { success: true, data: Number(value) } }
      } }).handler((_c, input) => {
        const value: number = input.text
        // @ts-expect-error Custom schema output is a number.
        const invalid: string = input.text
        // @ts-expect-error Undeclared schema fields are absent from handler input.
        input.params
        return { value }
      })`,
      'custom-async.post': `route().validate({ text: {
        async safeParseAsync(value: unknown) { return { success: true, data: Number(value) } }
      } }).handler((_c, input) => {
        const value: number = input.text
        // @ts-expect-error Asynchronous schema output is a number.
        const invalid: string = input.text
        return { value }
      })`,
      'optional.post':
        'route().validate({ json: z.object({ name: z.string() }).optional() }).handler((_c, input) => input.json ?? null)',
      'form.post':
        'route().validate({ form: z.object({ name: z.string() }) }).handler((_c, input) => input.form)',
      'fallback.all':
        'route().validate({ query: z.object({ term: z.string() }) }).handler((_c, input) => ({ fallback: input.query.term }))',
      'mixed.all':
        'route().validate({ json: z.object({ value: z.number() }) }).handler((_c, input) => ({ fallback: input.json.value }))',
      'mixed.get': 'route().handler(() => ({ specific: true }))',
      'lookup.query':
        'route().validate({ json: z.object({ term: z.string() }) }).handler((_c, input) => ({ found: input.json.term }))',
      'date.get': 'route().handler(() => ({ date: new Date() }))',
      'raw.get': "route().handler(() => new Response('hello'))",
      'text.get': "route().handler(ctx => ctx.text('hello'))",
      'empty.get': 'route().handler(ctx => ctx.body(null, 204))',
      'dynamic.get': `route().handler(ctx => {
        function status(): import('hono/utils/http-status').ContentfulStatusCode {
          return Math.random() > 0.5 ? 200 : 400
        }
        return ctx.json({ ok: true }, status())
      })`,
      'api.items.get': 'route().handler(() => [])',
      'read.[id].get': 'route().handler(ctx => ({ id: ctx.req.param("id") }))',
      'rawfiles.[...path].get': 'route().handler(ctx => ({ path: ctx.req.param("path") }))',
      'users.[id].get':
        'route().validate({ params: z.object({ id: z.string() }) }).handler((_c, input) => input.params)',
    }
    for (const [name, declaration] of Object.entries(routes)) {
      writeFileSync(
        join(root, 'api', `${name}.ts`),
        `import { route, z } from '@olivaw/sark/server'\nexport default ${declaration}\n`,
      )
    }
    writeFileSync(
      join(root, 'contracts.ts'),
      readFileSync('tests/fixtures/http-contracts.ts.txt', 'utf8'),
    )
    writeFileSync(
      join(root, 'tsconfig.json'),
      JSON.stringify({
        extends: resolve('tsconfig.json'),
        include: ['**/*.ts'],
      }),
    )
    await resolveConfig(
      {
        root,
        configFile: false,
        logLevel: 'silent',
        plugins: [sark({ apiPrefix, generatedDir: 'generated' })],
      },
      'build',
    )
    const pnpm = process.env.npm_execpath
    if (!pnpm) throw new Error('Run type contracts through the project pnpm scripts.')
    const args = ['typecheck', '--project', join(root, 'tsconfig.json')]
    const nodeScript = /\.(?:c|m)?js$/i.test(pnpm)
    const result = spawnSync(
      nodeScript ? process.execPath : pnpm,
      nodeScript ? [pnpm, ...args] : args,
      {
        cwd: projectRoot,
        encoding: 'utf8',
      },
    )
    if (result.error) throw result.error
    return result
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

async function compileWorkerFixture(appSource: string, envDeclaration?: string) {
  mkdirSync(join(projectRoot, '.build'), { recursive: true })
  const root = mkdtempSync(join(projectRoot, '.build/types-worker-'))
  try {
    mkdirSync(join(root, 'api'))
    writeFileSync(join(root, 'app.ts'), appSource)
    writeFileSync(
      join(root, 'api/ping.get.ts'),
      "import { route } from '@olivaw/sark/server'\nexport default route().handler(() => 'pong')\n",
    )
    if (envDeclaration) {
      writeFileSync(join(root, 'env.d.ts'), envDeclaration)
    }
    writeFileSync(
      join(root, 'tsconfig.json'),
      JSON.stringify({
        extends: resolve('tsconfig.json'),
        include: ['**/*.ts'],
      }),
    )
    await resolveConfig(
      {
        root,
        configFile: false,
        logLevel: 'silent',
        plugins: [sark({ target: 'cloudflare', generatedDir: 'generated' })],
      },
      'build',
    )
    const pnpm = process.env.npm_execpath
    if (!pnpm) throw new Error('Run type contracts through the project pnpm scripts.')
    const args = ['typecheck', '--project', join(root, 'tsconfig.json')]
    const nodeScript = /\.(?:c|m)?js$/i.test(pnpm)
    const result = spawnSync(
      nodeScript ? process.execPath : pnpm,
      nodeScript ? [pnpm, ...args] : args,
      {
        cwd: projectRoot,
        encoding: 'utf8',
      },
    )
    if (result.error) throw result.error
    return result
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('generated application type contracts', () => {
  for (const prefix of ['/api', '/v1/service', '/']) {
    it(`checks generated assembly, registration, startup and client calls for ${prefix}`, async () => {
      const result = await compileFixture(prefix)
      expect(result.status, result.stdout + result.stderr).toBe(0)
    })
  }

  for (const declaration of ['app', 'runtime']) {
    it(`rejects a narrower ${declaration} environment in the real Node startup`, async () => {
      const result = await compileFixture(
        '/api',
        declaration === 'app'
          ? `
import { defineApp } from '@olivaw/sark/server'
export const app = defineApp((env: { REQUIRED_HOST: string }) => ({ hosts: env.REQUIRED_HOST }))
`
          : `
import { defineNodeRuntime } from '@olivaw/sark/server/node'
export const runtime = defineNodeRuntime((env: { REQUIRED_PORT: string }) => ({ port: Number(env.REQUIRED_PORT) }))
`,
      )
      expect(result.status).not.toBe(0)
      expect(result.stdout).toContain('generated/start.ts')
      expect(result.stdout).toMatch(/(?:Type|Argument of type) 'ProcessEnv'/)
      expect(result.stdout).not.toContain("Unused '@ts-expect-error'")
    })
  }

  it('checks generated worker entry type contracts against project Wrangler Env', async () => {
    // 1. Positive case: Env satisfies application requirements
    const okResult = await compileWorkerFixture(
      `
import { defineApp } from '@olivaw/sark/server'
export const app = defineApp((env: { KV: string; SECRET: string }) => ({}))
`,
      `
declare global {
  interface Env {
    KV: string
    SECRET: string
  }
}
export {}
`,
    )
    expect(okResult.status, okResult.stdout + okResult.stderr).toBe(0)

    // 2. Negative case: Env missing required binding fails typecheck in generated worker.ts
    const failResult = await compileWorkerFixture(
      `
import { defineApp } from '@olivaw/sark/server'
export const app = defineApp((env: { REQUIRED_BINDING: string }) => ({}))
`,
      `
declare global {
  interface Env {
    DIFFERENT_BINDING: string
  }
}
export {}
`,
    )
    expect(failResult.status).not.toBe(0)
    expect(failResult.stdout).toContain('generated/worker.ts')
    expect(failResult.stdout).toMatch(
      /(?:Property 'REQUIRED_BINDING' is missing|Type 'Env' is not assignable)/,
    )
  })
})
