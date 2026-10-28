import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, it } from 'vitest'

import { discoverApiRoutes } from '../../src/tooling/build/discover/routes'
function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'sark-scope-test-'))
  try {
    run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

it('discovers directory middlewares and pairs them with descendant routes in outside-in order', () => {
  withTempDir((root) => {
    writeFileSync(join(root, '_middleware.ts'), 'export default async (ctx, next) => next()')
    mkdirSync(join(root, 'users'), { recursive: true })
    writeFileSync(join(root, 'users/_middleware.ts'), 'export default async (ctx, next) => next()')
    writeFileSync(
      join(root, 'users/profile.get.ts'),
      "import { route } from '@olivaw/sark/server'; export default route().handler(() => 'profile')",
    )
    writeFileSync(
      join(root, 'health.get.ts'),
      "import { route } from '@olivaw/sark/server'; export default route().handler(() => 'ok')",
    )

    const routes = discoverApiRoutes(root, '/api')
    expect(routes).toHaveLength(2)

    const health = routes.find((r) => r.routePath.urlPath === '/api/health')!
    expect(health).toBeDefined()
    expect(health.ancestorMiddlewares).toHaveLength(1)
    expect(health.ancestorMiddlewares[0].scopeKey).toBe('')

    const profile = routes.find((r) => r.routePath.urlPath === '/api/users/profile')!
    expect(profile).toBeDefined()
    expect(profile.ancestorMiddlewares).toHaveLength(2)
    expect(profile.ancestorMiddlewares[0].scopeKey).toBe('')
    expect(profile.ancestorMiddlewares[1].scopeKey).toBe('users')
  })
})

it('supports flat dot notation for middleware and preserves route scope pairing', () => {
  withTempDir((root) => {
    writeFileSync(
      join(root, 'admin.users._middleware.ts'),
      'export default async (ctx, next) => next()',
    )
    writeFileSync(
      join(root, 'admin.users.list.get.ts'),
      "import { route } from '@olivaw/sark/server'; export default route().handler(() => 'admin-users')",
    )

    const routes = discoverApiRoutes(root, '/api')
    expect(routes).toHaveLength(1)
    const listRoute = routes[0]
    expect(listRoute.routePath.urlPath).toBe('/api/admin/users/list')
    expect(listRoute.ancestorMiddlewares).toHaveLength(1)
    expect(listRoute.ancestorMiddlewares[0].scopeKey).toBe('admin/users')
  })
})

it('supports group folders for scope inheritance without affecting the URL route path', () => {
  withTempDir((root) => {
    mkdirSync(join(root, '(auth)'), { recursive: true })
    writeFileSync(join(root, '(auth)/_middleware.ts'), 'export default async (ctx, next) => next()')
    writeFileSync(
      join(root, '(auth)/login.post.ts'),
      "import { route } from '@olivaw/sark/server'; export default route().handler(() => 'login')",
    )

    const routes = discoverApiRoutes(root, '/api')
    expect(routes).toHaveLength(1)
    const loginRoute = routes[0]
    expect(loginRoute.routePath.urlPath).toBe('/api/login')
    expect(loginRoute.ancestorMiddlewares).toHaveLength(1)
    expect(loginRoute.ancestorMiddlewares[0].scopeKey).toBe('(auth)')
  })
})

it('rejects middleware collisions when flat dot and nested folder declare identical scopes', () => {
  withTempDir((root) => {
    mkdirSync(join(root, 'users'), { recursive: true })
    writeFileSync(join(root, 'users/_middleware.ts'), 'export default async (ctx, next) => next()')
    writeFileSync(join(root, 'users._middleware.ts'), 'export default async (ctx, next) => next()')
    writeFileSync(
      join(root, 'users/list.get.ts'),
      "import { route } from '@olivaw/sark/server'; export default route().handler(() => 'list')",
    )

    expect(() => discoverApiRoutes(root, '/api')).toThrowError(/Middleware conflict detected/)
  })
})
