import { generateSignedCookie } from 'hono/cookie'
import { build, createServer } from 'vite'
import { describe, expect, it } from 'vitest'

import { sark } from '../../src/entries/vite'
import { createProject, serverUrl, viteEntry } from '../helpers/project'

const VISITOR_SECRET = 'a-very-long-visitor-secret-key-32-chars!'
describe('Visitors Integration', { timeout: 15_000 }, () => {
  it('initializes visitor via POST /__sark/visitor (204 no-store) and maintains visitor across business requests', async () => {
    const project = createProject()
    project.write(
      'app.ts',
      `import { defineApp } from '@olivaw/sark'
import { defineVisitors } from '@olivaw/sark/visitors'

export const app = defineApp({ hosts: '127.0.0.1' })
export const visitors = defineVisitors({ secret: ${JSON.stringify(VISITOR_SECRET)} })
`,
    )
    project.write(
      'api/whoami.get.ts',
      `import { route } from '@olivaw/sark'

export default route().handler((ctx) => {
  return { visitorId: ctx.var.visitor.id }
})
`,
    )
    project.write(
      'vite.config.mts',
      `import { sark } from ${JSON.stringify(viteEntry)}
export default { cacheDir: '.build/vite-cache', plugins: [sark({ webDir: false })] }
`,
    )

    const server = await createServer({
      root: project.root,
      logLevel: 'silent',
      server: { host: '127.0.0.1', port: 0 },
    })

    try {
      await server.listen()
      const baseUrl = serverUrl(server.httpServer)

      // 1. Initial request to business API without cookie returns visitorId: null
      const preRes = await fetch(`${baseUrl}/api/whoami`)
      expect(preRes.status).toBe(200)
      expect((await preRes.json()).visitorId).toBeNull()

      // 2. Client initialization via POST /__sark/visitor
      const initRes = await fetch(`${baseUrl}/__sark/visitor`, {
        method: 'POST',
        headers: { Origin: baseUrl },
      })
      expect(initRes.status).toBe(204)
      expect(initRes.headers.get('cache-control')).toBe('no-store')
      expect(await initRes.text()).toBe('')

      const setCookie = initRes.headers.get('set-cookie')
      expect(setCookie).toBeTruthy()
      expect(setCookie).toContain('visitor_id=')
      expect(setCookie).toContain('Path=/')
      expect(setCookie).toContain('HttpOnly')
      expect(setCookie).toContain('SameSite=Lax')

      // Extract cookie value to forward in next business call
      const cookieVal = setCookie!.split(';')[0]

      // 3. Subsequent request with the cookie returns the initialized visitorId
      const postRes = await fetch(`${baseUrl}/api/whoami`, {
        headers: { Cookie: cookieVal },
      })
      expect(postRes.status).toBe(200)
      const data = await postRes.json()
      expect(data.visitorId).toBeTruthy()
      expect(typeof data.visitorId).toBe('string')
      expect(data.visitorId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      )
    } finally {
      await server.close()
      project.remove()
    }
  })

  it('supports custom initialization path and verifies old default path is not mounted', async () => {
    const project = createProject()
    project.write(
      'app.ts',
      `import { defineApp } from '@olivaw/sark'
import { defineVisitors } from '@olivaw/sark/visitors'

export const app = defineApp({ hosts: '127.0.0.1' })
export const visitors = defineVisitors({
  secret: ${JSON.stringify(VISITOR_SECRET)},
  path: '/custom/v-init',
})
`,
    )
    project.write(
      'vite.config.mts',
      `import { sark } from ${JSON.stringify(viteEntry)}
export default { cacheDir: '.build/vite-cache', plugins: [sark({ webDir: false })] }
`,
    )

    const server = await createServer({
      root: project.root,
      logLevel: 'silent',
      server: { host: '127.0.0.1', port: 0 },
    })

    try {
      await server.listen()
      const baseUrl = serverUrl(server.httpServer)

      // 1. Default path returns 404
      const defaultRes = await fetch(`${baseUrl}/__sark/visitor`, {
        method: 'POST',
        headers: { Origin: baseUrl },
      })
      expect(defaultRes.status).toBe(404)

      // 2. Custom path returns 204
      const customRes = await fetch(`${baseUrl}/custom/v-init`, {
        method: 'POST',
        headers: { Origin: baseUrl },
      })
      expect(customRes.status).toBe(204)
      expect(customRes.headers.get('set-cookie')).toContain('visitor_id=')
    } finally {
      await server.close()
      project.remove()
    }
  })

  it('exposes the configured initialization path without a returning visitor ID in SSR bootstrap data', async () => {
    const project = createProject()
    project.write(
      'app.ts',
      `import { defineApp } from '@olivaw/sark'
import { defineVisitors } from '@olivaw/sark/visitors'

export const app = defineApp({ hosts: '127.0.0.1' })
export const visitors = defineVisitors({
  secret: ${JSON.stringify(VISITOR_SECRET)},
  path: '/custom/bootstrap-visitor',
})
`,
    )
    project.write('app/index.tsx', `export default function IndexPage() { return <h1>Home</h1> }`)
    project.write(
      'vite.config.mts',
      `import { sark } from ${JSON.stringify(viteEntry)}
export default { cacheDir: '.build/vite-cache', plugins: [sark()] }
`,
    )

    const server = await createServer({
      root: project.root,
      logLevel: 'silent',
      server: { host: '127.0.0.1', port: 0 },
    })

    try {
      await server.listen()
      const baseUrl = serverUrl(server.httpServer)

      const visitorId = crypto.randomUUID()
      const cookie = await generateSignedCookie(
        'visitor_id',
        `v1:${visitorId}:${Date.now() + 60_000}`,
        VISITOR_SECRET,
      )
      const pageRes = await fetch(`${baseUrl}/`, { headers: { Cookie: cookie } })
      expect(pageRes.status).toBe(200)
      const html = await pageRes.text()
      expect(html).toContain('__PAGE_CONTEXT__')
      expect(html).toContain('"visitorPath":"/custom/bootstrap-visitor"')
      expect(html).not.toContain(visitorId)
    } finally {
      await server.close()
      project.remove()
    }
  })

  it('does not import or load runtime/visitors when visitors capability is omitted', async () => {
    const project = createProject()
    project.write(
      'app.ts',
      `import { defineApp } from '@olivaw/sark'
export const app = defineApp({ hosts: '127.0.0.1' })
`,
    )
    project.write(
      'vite.config.mts',
      `import { sark } from ${JSON.stringify(viteEntry)}
export default { cacheDir: '.build/vite-cache', plugins: [sark({ webDir: false })] }
`,
    )

    const server = await createServer({
      root: project.root,
      logLevel: 'silent',
      server: { host: '127.0.0.1', port: 0 },
    })

    try {
      await server.listen()
      const { readFileSync } = await import('node:fs')
      const { join } = await import('node:path')
      const generatedApp = readFileSync(join(project.root, '.build/app.ts'), 'utf-8')
      expect(generatedApp).not.toContain('@olivaw/sark/runtime/visitors')
      expect(generatedApp).not.toContain('createVisitorsAssembly')
    } finally {
      await server.close()
      project.remove()
    }
  })

  describe('Client Module Import Boundary', () => {
    it('allows visitor declarations and initialization through the same browser entry', async () => {
      const project = createProject()
      project.write(
        'entry.ts',
        `import { defineVisitors, ensureVisitor } from '@olivaw/sark/visitors'; export { defineVisitors, ensureVisitor }`,
      )
      try {
        const result = await build({
          root: project.root,
          configFile: false,
          logLevel: 'silent',
          plugins: [sark({ apiDir: false, webDir: false })],
          build: { write: false, lib: { entry: project.root + '/entry.ts', formats: ['es'] } },
        })
        expect(result).toBeTruthy()
      } finally {
        project.remove()
      }
    })
  })

  describe('Cloudflare Workers (workerd) Real Runtime', () => {
    it('initializes and reads visitor identity inside real workerd environment', async () => {
      const project = createProject()
      const appEntry = 'config/application.ts'
      const apiDir = 'handlers'
      const apiPrefix = '/api'

      project.write(
        appEntry,
        `import { defineApp } from '@olivaw/sark'
import { defineVisitors } from '@olivaw/sark/visitors'

export const app = defineApp({ hosts: '127.0.0.1' })
export const visitors = defineVisitors((env: { VISITOR_KEY: string }) => ({
  secret: env.VISITOR_KEY,
}))
`,
      )
      project.write(
        `${apiDir}/whoami.get.ts`,
        `import { route } from '@olivaw/sark'

export default route().handler((ctx) => {
  return { id: ctx.var.visitor.id }
})
`,
      )
      project.write(
        'vite.config.mts',
        `import { sark } from ${JSON.stringify(viteEntry)}
import { cloudflare } from '@cloudflare/vite-plugin'

export default {
  cacheDir: '.build/vite-cache',
  plugins: [
    sark({ target: 'cloudflare', appEntry: '${appEntry}', apiDir: '${apiDir}', apiPrefix: '${apiPrefix}', webDir: false }),
    cloudflare({ viteEnvironment: { name: 'ssr' }, inspectorPort: false, persistState: false, remoteBindings: false }),
  ],
}
`,
      )
      project.write(
        'wrangler.jsonc',
        JSON.stringify({
          name: 'sark-visitors-workerd',
          main: '.build/worker.ts',
          compatibility_date: '2026-10-01',
          compatibility_flags: ['nodejs_compat'],
          vars: { VISITOR_KEY: VISITOR_SECRET },
        }),
      )

      const server = await createServer({
        root: project.root,
        logLevel: 'silent',
        server: { host: '127.0.0.1', port: 0 },
      })

      try {
        await server.listen()
        const workerUrl = serverUrl(server.httpServer)

        // 1. Initial request without cookie -> visitor.id is null
        const preRes = await fetch(`${workerUrl}/api/whoami`)
        expect(preRes.status).toBe(200)
        expect((await preRes.json()).id).toBeNull()

        // 2. Initialize visitor identity via POST /__sark/visitor on workerd
        const initRes = await fetch(`${workerUrl}/__sark/visitor`, {
          method: 'POST',
          headers: { Origin: workerUrl },
        })
        expect(initRes.status).toBe(204)
        expect(initRes.headers.get('cache-control')).toBe('no-store')

        const setCookie = initRes.headers.get('set-cookie')
        expect(setCookie).toBeTruthy()
        expect(setCookie).toContain('visitor_id=')
        const cookieVal = setCookie!.split(';')[0]

        // 3. Read visitor identity in workerd using the established cookie
        const postRes = await fetch(`${workerUrl}/api/whoami`, {
          headers: { Cookie: cookieVal },
        })
        expect(postRes.status).toBe(200)
        const postData = await postRes.json()
        expect(postData.id).toBeTruthy()
        expect(typeof postData.id).toBe('string')
      } finally {
        await server.close()
        project.remove()
      }
    }, 45000)
  })
})
