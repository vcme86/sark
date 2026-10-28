import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { build } from 'vite'
import { expect, it } from 'vitest'

import { generateProject } from '../../src/tooling/build/project'
import { createProject } from '../helpers/project'

const secret = 'session-signing-secret-at-least-32-bytes'

it('runs generated session-only composition with OAuth packages blocked by the module loader', async () => {
  const project = createProject()
  project.write(
    'app.ts',
    `import { defineAuth } from '@olivaw/sark/auth/session'
export const auth = defineAuth({ secret: '${secret}' })`,
  )
  project.write(
    'api/me.get.ts',
    `import { route } from '@olivaw/sark/server'
export default route().handler(ctx => ({ user: ctx.var.auth.identity?.sub ?? null }))`,
  )
  try {
    generateProject(project.root)
    await build({
      root: project.root,
      configFile: false,
      logLevel: 'silent',
      build: {
        ssr: join(project.root, '.build/app.ts'),
        outDir: 'dist',
        rolldownOptions: {
          external: (id) => id.startsWith('@olivaw/sark/'),
          output: { entryFileNames: 'definition.mjs' },
        },
      },
    })
    const url = pathToFileURL(join(project.root, 'dist/definition.mjs')).href
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
import { registerHooks } from 'node:module'
registerHooks({ resolve(specifier, context, next) {
  if (['openid-client', 'oauth4webapi', 'jose'].includes(specifier)) throw new Error('Unused OAuth package loaded: ' + specifier)
  return next(specifier, context)
} })
const { definition } = await import(${JSON.stringify(url)})
const { createApp } = await import('@olivaw/sark/server')
const app = await createApp(definition)
try {
  const response = await app.fetch(new Request('http://localhost/api/me'))
  if (response.status !== 200 || (await response.json()).user !== null) throw new Error('Session pipeline failed')
} finally { await app.close() }
`,
      ],
      { cwd: project.root, encoding: 'utf8', timeout: 15000 },
    )
    if (result.error) throw result.error
    expect(result.status, result.stdout + result.stderr).toBe(0)
  } finally {
    project.remove()
  }
})
