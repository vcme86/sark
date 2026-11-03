import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { build } from 'vite'
import { describe, expect, it } from 'vitest'

import { parseApiFilePath } from '../../src/http/path'
import { sark } from '../../src/tooling/vite'
import { createProject } from '../helpers/project'

describe('Contract: Built Package Exports', () => {
  it('loads the Node Vite entry without loading the optional Wrangler SDK', () => {
    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import { registerHooks } from 'node:module'
      registerHooks({ resolve(specifier, context, next) {
        if (specifier === 'wrangler') throw new Error('Node tooling loaded Wrangler')
        return next(specifier, context)
      } })
      await import('@olivaw/sark/vite')
    `,
      ],
      { encoding: 'utf8', timeout: 10000 },
    )
    expect(child.status, child.stderr).toBe(0)
  })

  it('imports @olivaw/sark/server from build output', async () => {
    const server = await import('@olivaw/sark/server')
    expect(server.createApp).toBeDefined()
    expect(server.defineApp).toBeDefined()
    expect(server.route).toBeDefined()
    expect(server.HttpError).toBeDefined()
    expect(server.dedup).toBeDefined()
    expect(server.getLogger).toBeDefined()
    expect(server.z).toBeDefined()
    expect(server.getCookie).toBeDefined()
    expect(server.setCookie).toBeDefined()
  })

  it('imports @olivaw/sark/http from build output', async () => {
    const http = await import('@olivaw/sark/http')
    expect(http.createClient).toBeDefined()
    expect(http.HttpError).toBeDefined()

    const client = http.createClient({ baseUrl: 'http://localhost:3000/api' })
    expect(client.get).toBeDefined()
    expect(client.post).toBeDefined()
    expect(client.requestRaw).toBeDefined()
  })

  it('imports @olivaw/sark/utils from build output', async () => {
    const utils = await import('@olivaw/sark/utils')
    expect(utils.parseCookie).toBeDefined()
    expect(utils.serializeCookie).toBeDefined()

    const parsed = utils.parseCookie('session=abc; theme=dark')
    expect(parsed.session).toBe('abc')
    expect(parsed.theme).toBe('dark')
  })

  it('executes public middleware and Node runtime entries through HTTP', async () => {
    const [
      { createApp, defineApp, route },
      { createDefinition },
      { startNodeServer },
      { defineNodeRuntime },
      { cors, csrf, compress },
    ] = await Promise.all([
      import('@olivaw/sark/server'),
      import('@olivaw/sark/runtime/core'),
      import('@olivaw/sark/runtime/node'),
      import('@olivaw/sark/server/node'),
      import('@olivaw/sark/middleware'),
    ])
    const payload = { value: 'A'.repeat(5000) }
    const instance = await createApp(
      createDefinition({
        app: defineApp({
          csrf: false,
          middleware: [
            cors({ origin: 'https://frontend.example' }),
            csrf({ origins: ['https://frontend.example'] }),
            compress({ threshold: 0 }),
          ],
        }),
        routes: [
          {
            routePath: parseApiFilePath('ping.all.ts', '/api')!,
            declaration: route().handler(() => payload),
          },
        ],
      }),
    )
    const host = await startNodeServer(
      instance,
      defineNodeRuntime({
        port: 0,
        hostname: '127.0.0.1',
        probes: false,
        compress: false,
      }),
    )
    try {
      const url = `http://127.0.0.1:${host.port}/api/ping`
      const response = await fetch(url, {
        headers: {
          Origin: 'https://frontend.example',
          'Accept-Encoding': 'gzip',
        },
      })
      expect(response.status).toBe(200)
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://frontend.example')
      expect(response.headers.get('Content-Encoding')).toBe('gzip')
      expect(await response.json()).toEqual(payload)
      const rejected = await fetch(url, {
        method: 'POST',
        body: 'hello',
        headers: {
          Origin: 'https://other.example',
          'Content-Type': 'text/plain',
        },
      })
      expect(rejected.status).toBe(403)
      expect((await rejected.json()).error.code).toBe('csrf_forbidden')
    } finally {
      await host.close()
    }
  })

  it('imports @olivaw/sark/runtime/core from build output', async () => {
    const runtimeCore = await import('@olivaw/sark/runtime/core')
    expect(runtimeCore.createDefinition).toBeDefined()
  })

  it('imports @olivaw/sark/runtime/node from build output', async () => {
    const runtimeNode = await import('@olivaw/sark/runtime/node')
    expect(Object.keys(runtimeNode).toSorted()).toEqual(['loadNodeEnv', 'startNodeServer'])
  })

  it('imports @olivaw/sark/runtime/cloudflare from build output', async () => {
    const runtimeCf = await import('@olivaw/sark/runtime/cloudflare')
    expect(Object.keys(runtimeCf).toSorted()).toEqual(['createWorkerHandler'])
  })

  it('imports @olivaw/sark/vite from build output', async () => {
    const vite = await import('@olivaw/sark/vite')
    expect(vite.sark).toBeDefined()
    const plugin = vite.sark({ target: 'node' })
    expect(plugin.name).toBe('@olivaw/sark')
  })

  it('imports @olivaw/sark/page with strictly public non-secret exports', async () => {
    const page = await import('@olivaw/sark/page')
    expect(Object.keys(page).toSorted()).toEqual([
      'NotFoundSignal',
      'RedirectSignal',
      'definePage',
      'notFound',
      'redirect',
    ])
    expect(page).not.toHaveProperty('resolvePageConfig')
  })

  it('imports @olivaw/sark/client from build output', async () => {
    const client = await import('@olivaw/sark/client')
    expect(client.Link).toBeDefined()
    expect(client.Outlet).toBeDefined()
    expect(client.useNavigate).toBeDefined()
    expect(client.useAction).toBeDefined()
    expect(client.useBlocker).toBeDefined()
  })

  it('imports @olivaw/sark/auth/session from build output', async () => {
    const session = await import('@olivaw/sark/auth/session')
    expect(session.defineAuth).toBeDefined()
    expect(session.requireStepUp).toBeDefined()
    expect(session.signToken).toBeDefined()
    expect(session.verifyToken).toBeDefined()
    // Internal functions must not be leaked into public entry
    expect(session).not.toHaveProperty('createAuthService')
    expect(session).not.toHaveProperty('formatSetCookie')
    expect(session).not.toHaveProperty('resolveAuthConfig')
  })

  it('imports @olivaw/sark/auth/oauth from build output', async () => {
    const oauth = await import('@olivaw/sark/auth/oauth')
    expect(oauth.defineOAuth).toBeDefined()
  })
})

it.each([
  'db/d1',
  'auth/session',
  'auth/oauth',
  'auth/mfa',
  'auth/totp',
  'auth/webauthn',
  'auth/totp/d1',
  'auth/webauthn/d1',
  'auth/recovery/d1',
  'auth/state/d1',
])('rejects the server capability %s in a real browser build', async (entry) => {
  const project = createProject()
  project.write(
    'entry.ts',
    `import * as capability from '@olivaw/sark/${entry}'; console.log(capability)`,
  )
  try {
    await expect(
      build({
        root: project.root,
        configFile: false,
        logLevel: 'silent',
        plugins: [sark({ apiDir: false, webDir: false })],
        build: { write: false, lib: { entry: project.root + '/entry.ts', formats: ['es'] } },
      }),
    ).rejects.toThrow(/cannot import server module/)
  } finally {
    project.remove()
  }
})

it('allows erased database types and the page declaration in a browser build', async () => {
  const project = createProject()
  project.write(
    'entry.ts',
    `import type { D1Config } from '@olivaw/sark/db/d1'
import { definePage } from '@olivaw/sark/page'
export const options: D1Config | null = null
export const page = definePage({})`,
  )
  try {
    await expect(
      build({
        root: project.root,
        configFile: false,
        logLevel: 'silent',
        plugins: [sark({ apiDir: false, webDir: false })],
        build: { write: false, lib: { entry: project.root + '/entry.ts', formats: ['es'] } },
      }),
    ).resolves.toBeDefined()
  } finally {
    project.remove()
  }
})

it('allows the WebAuthn browser helper in a real browser build', async () => {
  const project = createProject()
  project.write(
    'entry.ts',
    `import { startAuthentication } from '@olivaw/sark/auth/webauthn/browser'; export { startAuthentication }`,
  )
  try {
    await expect(
      build({
        root: project.root,
        configFile: false,
        logLevel: 'silent',
        plugins: [sark({ apiDir: false, webDir: false })],
        build: { write: false, lib: { entry: project.root + '/entry.ts', formats: ['es'] } },
      }),
    ).resolves.toBeDefined()
  } finally {
    project.remove()
  }
})

describe('package manifest', () => {
  it('package type exports point to real build files', () => {
    const pkgPath = join(process.cwd(), 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    for (const value of Object.values(pkg.exports) as Array<{ types: string }>) {
      expect(existsSync(join(process.cwd(), value.types))).toBe(true)
    }
  })
})
