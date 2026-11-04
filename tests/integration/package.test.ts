import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { sark } from '@olivaw/sark/vite'
import { build } from 'vite'
import { describe, expect, it } from 'vitest'

import { parseApiFilePath } from '../../src/http/path'
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

  it.each([
    '',
    '/node',
    '/page',
    '/client',
    '/visitors',
    '/runtime/cloudflare',
    '/runtime/page-server',
  ])('loads the %s entry without unselected SDKs or initialization', (entry) => {
    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
const entry = ${JSON.stringify('@olivaw/sark')} + ${JSON.stringify(entry)}
const optional = [
  '@aws-sdk/',
  '@simplewebauthn/',
  '@otplib/',
  'drizzle-orm',
  'better-sqlite3',
  'postgres',
  'openid-client',
  'croner',
  '@prometheus-io/',
  'lru-cache',
]
registerHooks({ resolve(specifier, context, next) {
  if (optional.some(name => specifier === name || specifier.startsWith(name.endsWith('/') ? name : name + '/'))) {
    throw new Error('Unselected dependency loaded by ' + entry + ': ' + specifier)
  }
  if (entry !== '@olivaw/sark/page' && entry !== '@olivaw/sark/runtime/page-server' && (specifier === 'react' || specifier.startsWith('react/') || specifier.startsWith('react-dom'))) {
    throw new Error('Non-page entry loaded React: ' + entry)
  }
  return next(specifier, context)
} })
globalThis.fetch = () => { throw new Error('Import performed a network request') }
const api = await import(entry)
if (entry.endsWith('/node')) {
  assert.equal(api.defineAssets([{ path: '/files', dir: './unopened-directory' }]).kind, 'assets')
  assert.equal(api.defineHealth({ readiness: { business: () => { throw new Error('Declaration ran a check') } } }).kind, 'health')
  assert.equal(api.defineNodeRuntime({ port: 0 }).value.port, 0)
}
`,
      ],
      { encoding: 'utf8', timeout: 10000 },
    )
    expect(child.status, child.stderr).toBe(0)
  })

  it('uses the standalone HTTP client and Cookie helpers from one entry', async () => {
    const {
      createClient,
      HttpError,
      parseCookie,
      serializeCookie,
      parseSignedCookie,
      serializeSignedCookie,
    } = await import('@olivaw/sark/client')
    const client = createClient({
      baseUrl: 'https://api.example.test/api',
      fetch: async (request) => {
        if (new URL(request.url).pathname === '/api/missing')
          return new HttpError(404, 'Missing').toResponse()
        return Response.json({ method: request.method, cookie: request.headers.get('Cookie') })
      },
    })
    const cookie = serializeCookie('theme', 'dark')
    expect(parseCookie(cookie).theme).toBe('dark')
    expect(await client.get('/settings', { headers: { Cookie: cookie } })).toEqual({
      method: 'GET',
      cookie,
    })
    await expect(client.get('/missing')).rejects.toBeInstanceOf(HttpError)
    const signed = await serializeSignedCookie('session', 'reader', 'test-signing-key')
    expect((await parseSignedCookie(signed, 'test-signing-key')).session).toBe('reader')
  })

  it('executes public middleware and Node runtime entries through HTTP', async () => {
    const [
      { createApp, defineApp, route },
      { createDefinition },
      { startNodeServer },
      { defineNodeRuntime },
      { cors, csrf, compress },
      { requireStepUp },
    ] = await Promise.all([
      import('@olivaw/sark'),
      import('@olivaw/sark/runtime/core'),
      import('@olivaw/sark/runtime/node'),
      import('@olivaw/sark/node'),
      import('@olivaw/sark/middleware'),
      import('@olivaw/sark/auth'),
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
          {
            routePath: parseApiFilePath('sensitive.get.ts', '/api')!,
            declaration: route({ middleware: [requireStepUp({ maxAge: 60000 })] }).handler(() => ({
              allowed: true,
            })),
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
      const sensitive = await fetch(`http://127.0.0.1:${host.port}/api/sensitive`)
      expect(sensitive.status).toBe(403)
      expect((await sensitive.json()).error.code).toBe('step_up_required')
    } finally {
      await host.close()
    }
  })

  it('renders the public page Link during SSR without a browser or provider', async () => {
    const { createElement } = await import('react')
    const { renderToStaticMarkup } = await import('react-dom/server')
    const { definePage, Link, redirect, RedirectSignal } = await import('@olivaw/sark/page')
    expect(definePage({}).kind).toBe('page')
    expect(renderToStaticMarkup(createElement(Link, { to: '/articles' }, 'Articles'))).toBe(
      '<a href="/articles">Articles</a>',
    )
    expect(() => redirect('/signin')).toThrow(RedirectSignal)
  })

  it('signs and verifies identities through the public auth entry without exposing internals', async () => {
    const session = await import('@olivaw/sark/auth')
    const input = { sub: 'reader', ver: 4, roles: ['editor'], claims: { tenant: 'publication' } }
    const options = {
      secret: 'public-auth-entry-signing-key-at-least-32-bytes',
      issuer: 'publication',
      audience: 'reader',
      expiresIn: 60000,
    }
    const token = await session.signToken(input, options)
    expect(await session.verifyToken(token, options)).toMatchObject(input)
    expect(
      await session.verifyToken(token, {
        ...options,
        secret: 'different-auth-entry-signing-key-at-least-32-bytes',
      }),
    ).toBeNull()
    expect(session).not.toHaveProperty('createAuthService')
    expect(session).not.toHaveProperty('formatSetCookie')
    expect(session).not.toHaveProperty('resolveAuthConfig')
  })
})

it.each([
  'db/d1',
  '',
  'node',
  'middleware',
  'auth',
  'jobs',
  'logging',
  'storage/r2',
  'vite',
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
    `import * as capability from '@olivaw/sark${entry ? '/' + entry : ''}'; console.log(capability)`,
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
