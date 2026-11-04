import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { discoverApiRoutes } from '../../src/tooling/build/discover/routes'
import { generateBuildArtifacts } from '../../src/tooling/build/generate'

function withTempProject(fn: (projectDir: string) => Promise<void> | void): Promise<void> {
  mkdirSync('.build', { recursive: true })
  const dir = mkdtempSync(resolve('.build/configuration-'))
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => {
      rmSync(dir, { recursive: true, force: true })
    })
}

describe('Event configuration and assembly', () => {
  it('cleans up opposing target entry files upon switching between node and cloudflare targets', async () => {
    await withTempProject((root) => {
      const generatedDir = join(root, '.build')

      // Step A: Generate for Node
      generateBuildArtifacts({
        generatedDir,
        appEntryPath: join(root, 'app.ts'),
        appExports: { exports: ['app'] },
        routes: [],
        apiPrefix: '/api',
        webPrefix: '/',
        target: 'node',
      })
      expect(existsSync(join(generatedDir, 'start.ts'))).toBe(true)
      expect(existsSync(join(generatedDir, 'worker.ts'))).toBe(false)

      // Step B: Switch to Cloudflare in same project
      generateBuildArtifacts({
        generatedDir,
        appEntryPath: join(root, 'app.ts'),
        appExports: { exports: ['app'] },
        routes: [],
        apiPrefix: '/api',
        webPrefix: '/',
        target: 'cloudflare',
      })
      expect(existsSync(join(generatedDir, 'worker.ts'))).toBe(true)
      expect(existsSync(join(generatedDir, 'start.ts'))).toBe(false)

      // Step C: Switch back to Node in same project
      generateBuildArtifacts({
        generatedDir,
        appEntryPath: join(root, 'app.ts'),
        appExports: { exports: ['app'] },
        routes: [],
        apiPrefix: '/api',
        webPrefix: '/',
        target: 'node',
      })
      expect(existsSync(join(generatedDir, 'start.ts'))).toBe(true)
      expect(existsSync(join(generatedDir, 'worker.ts'))).toBe(false)
    })
  })

  it('discovers ancestor middlewares for api/users/_middleware.ts and omits .scope when absent', async () => {
    await withTempProject((root) => {
      const apiDir = join(root, 'api')
      mkdirSync(join(apiDir, 'users'), { recursive: true })

      // A default-only middleware must not require a named scope export.
      writeFileSync(
        join(apiDir, 'users/_middleware.ts'),
        `import { createMiddleware } from 'hono/factory'
export default createMiddleware(async (c, next) => {
  c.header('X-Users-Scope', 'true')
  return next()
})
`,
      )

      writeFileSync(
        join(apiDir, 'users/get.ts'),
        `import { route } from '@olivaw/sark'
export default route().handler(() => ({ users: [] }))
`,
      )

      const routes = discoverApiRoutes(apiDir, '/api')
      expect(routes.length).toBe(1)
      const userRoute = routes[0]
      expect(userRoute.routePath.urlPath).toBe('/api/users')
      // 1. The method-only route inherits middleware from its directory.
      expect(userRoute.ancestorMiddlewares.length).toBe(1)
      expect(userRoute.ancestorMiddlewares[0].scopeKey).toBe('users')
      expect(userRoute.ancestorMiddlewares[0].hasScope).toBe(false)
      expect(userRoute.ancestorMiddlewares[0].hasDefault).toBe(true)

      // 2. Generated code imports only the middleware exports that exist.
      const generatedDir = join(root, '.build')
      generateBuildArtifacts({
        generatedDir,
        appEntryPath: join(root, 'app.ts'),
        appExports: { exports: [] },
        routes,
        apiPrefix: '/api',
        webPrefix: '/',
        target: 'node',
      })

      const appTs = readFileSync(join(generatedDir, 'app.ts'), 'utf-8')
      expect(appTs).toContain('{ middleware: middleware_0.default }')
      expect(appTs).not.toContain('middleware_0.scope')
    })
  })
})
