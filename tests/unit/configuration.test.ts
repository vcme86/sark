import { resolve } from 'node:path'

import { afterEach, expect, it, vi } from 'vitest'

import { defineNodeRuntime, resolveNodeRuntime } from '../../src/adapter/node/runtime'
import { type AppConfig, resolveHttpConfig } from '../../src/app/config'
import { computeEffectivePolicy } from '../../src/app/http/policy'
import { createPageConfigResolver, definePage, resolvePageConfig } from '../../src/page/config'
import { resolvePluginOptions, resolveProjectConfig } from '../../src/tooling/config'
afterEach(() => vi.unstubAllEnvs())
it('normalizes prefixes once and binds all discovery paths to the supplied root', () => {
  const options = resolvePluginOptions({
    appEntry: 'config/app.ts',
    apiDir: 'handlers',
    apiPrefix: '/service//v2/',
    webDir: false,
    webPrefix: '/site//articles/',
    target: undefined,
  })
  expect(options.apiPrefix).toBe('/service/v2')
  expect(options.target).toBe('node')
  expect(options.webDir).toBe(false)
  expect(options.webPrefix).toBe('/site/articles')
  const project = resolveProjectConfig('/example', options)
  expect(project.appEntryPath).toBe(resolve('/example/config/app.ts'))
  expect(project.apiDir).toBe(resolve('/example/handlers'))
  expect(project.generatedDir).toBe(resolve('/example/.build'))
  expect(project.target).toBe(options.target)
  expect(project.apiPrefix).toBe(options.apiPrefix)
  expect(project.webPrefix).toBe(options.webPrefix)
  expect(project.webDir).toBe(false)
  expect(resolveProjectConfig('/example', resolvePluginOptions({ apiDir: false })).apiDir).toBe(
    false,
  )
})

it.each(['api', '//example.test', '/api?version=2', '/api/../private'])(
  'rejects an invalid API prefix: %s',
  (apiPrefix) => expect(() => resolvePluginOptions({ apiPrefix })).toThrow(/apiPrefix/),
)

it('rejects null rather than restoring a default', () => {
  // @ts-expect-error JavaScript callers can supply values outside the public type.
  expect(() => resolvePluginOptions({ apiDir: null })).toThrow(/apiDir/)
})

it('merges partial objects and retains explicit disabled policies, zero and empty arrays', () => {
  vi.stubEnv('NODE_ENV', 'production')
  const input: AppConfig = {
    headers: { 'x-frame-options': false, 'X-Custom': 'value', 'Referrer-Policy': undefined },
    bodyLimit: 0,
    trustedProxies: [],
    middleware: [],
    cors: false,
    csrf: false,
    cookie: { sameSite: undefined, secure: false },
  }
  const resolved = resolveHttpConfig(input)
  expect(resolved.headers).toEqual({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Custom': 'value',
  })
  expect(resolved.bodyLimit).toBe(0)
  expect(resolved.trustedProxies).toEqual([])
  expect(resolved.trustedProxies).not.toBe(input.trustedProxies)
  expect(resolved.middleware).not.toBe(input.middleware)
  expect(resolved.cookie).toEqual({ sameSite: 'lax', secure: false, secret: undefined })
  expect(resolved.cors).toBe(false)
  expect(resolved.csrf).toBe(false)
  expect(input.headers).toHaveProperty('Referrer-Policy', undefined)
  expect(resolveHttpConfig().headers).toHaveProperty('X-Frame-Options', 'SAMEORIGIN')
  expect(resolveHttpConfig({ headers: false }).headers).toBe(false)
})

it('inherits custom resolved application policy while explicit route fields replace it', () => {
  const app = resolveHttpConfig({
    bodyLimit: 12,
    cors: { origin: 'https://app.test' },
    csrf: false,
  })
  expect(computeEffectivePolicy(app, { bodyLimit: undefined })).toEqual({
    bodyLimit: 12,
    cors: app.cors,
    csrf: false,
  })
  expect(computeEffectivePolicy(app, { bodyLimit: false, cors: false, csrf: true })).toEqual({
    bodyLimit: false,
    cors: false,
    csrf: true,
  })
})

it.each([-1, 1.5, NaN, Infinity])('rejects invalid bodyLimit %s', (bodyLimit) => {
  expect(() => resolveHttpConfig({ bodyLimit })).toThrow(/bodyLimit/)
  expect(() => computeEffectivePolicy(resolveHttpConfig(), { bodyLimit })).toThrow(/bodyLimit/)
})

it('does not treat null Cookie settings as omitted', () => {
  // @ts-expect-error Invalid JavaScript input must fail at the owner boundary.
  expect(() => resolveHttpConfig({ cookie: { secure: null } })).toThrow(/Cookie/)
  // @ts-expect-error Null is not an allowed Cookie configuration.
  expect(() => resolveHttpConfig({ cookie: null })).toThrow(/cookie/)
})

it.each([
  undefined,
  'https://api.example.test/v1?key=value',
  'https://api.example.test/v1#fragment',
  'https://user:password@api.example.test/v1',
  'https://api.example.test/v1?',
  'not a URL',
])('rejects an invalid remote API base at resolution: %s', (serverUrl) => {
  expect(() => resolvePageConfig(definePage({ api: { serverUrl } }), {}, '/api')).toThrow(
    /page.api.serverUrl/,
  )
})

it.each(['/api?key=value', '/api#fragment', 'https://user:password@example.test/api'])(
  'rejects an invalid browser API base: %s',
  (browserUrl) => {
    expect(() =>
      resolvePageConfig(
        definePage({ api: { serverUrl: 'https://api.example.test/v1', browserUrl } }),
        {},
        '/api',
      ),
    ).toThrow(/page.api.browserUrl/)
  },
)

it('reuses static page settings within a runtime and isolates separate runtimes', () => {
  const declaration = definePage({})
  const first = createPageConfigResolver(declaration, '/api')
  const second = createPageConfigResolver(declaration, '/api')
  expect(first({})).toBe(first({}))
  expect(first({})).not.toBe(second({}))
})

it('evaluates factories with the current event environment', () => {
  const factory = vi.fn((env: { API: string }) => ({ api: { serverUrl: env.API } }))
  const resolveConfig = createPageConfigResolver(definePage(factory), '/api')
  expect(resolveConfig({ API: 'https://first.test/api' }).api.serverUrl).toBe(
    'https://first.test/api',
  )
  expect(resolveConfig({ API: 'https://second.test/api' }).api.serverUrl).toBe(
    'https://second.test/api',
  )
  expect(factory).toHaveBeenCalledTimes(2)
})

it('resolves partial shutdown, probes and compression before hosting', () => {
  const input = {
    port: 0,
    compress: { encoding: undefined },
    shutdown: { deadline: 5000 },
    probes: { readiness: '/status' },
  }
  const result = resolveNodeRuntime(defineNodeRuntime(input), { PORT: '8000' })
  expect(result.port).toBe(0)
  expect(result.shutdown).toEqual({ deadline: 5000, reserve: 2000 })
  expect(result.probes).toEqual({ liveness: '/livez', readiness: '/status' })
  expect(result.compress).toEqual({ encoding: 'gzip' })
  expect(input.compress.encoding).toBeUndefined()
  expect(resolveNodeRuntime(defineNodeRuntime({ compress: false, probes: false }))).toMatchObject({
    compress: false,
    probes: false,
  })
})

it('keeps runtime factories lazy and fails on missing required environment', () => {
  const factory = vi.fn((env: { port: number }) => ({ port: env.port }))
  const declaration = defineNodeRuntime(factory)
  expect(factory).not.toHaveBeenCalled()
  expect(() => resolveNodeRuntime(declaration)).toThrow(/Environment required/)
  expect(factory).not.toHaveBeenCalled()
  expect(resolveNodeRuntime(declaration, { port: 0 }).port).toBe(0)
  expect(factory).toHaveBeenCalledTimes(1)
})

it('correctly resolves page config for static objects and environment factories', async () => {
  // Static object configuration
  const staticDecl = definePage({
    api: { serverUrl: 'http://internal-backend:8080' },
  })
  const resolvedStatic = resolvePageConfig(staticDecl, {}, '/custom-api')
  expect(resolvedStatic?.api?.serverUrl).toBe('http://internal-backend:8080')
  expect(resolvedStatic?.api?.browserUrl).toBe('/custom-api')

  // Factory configuration receiving environment
  interface MyEnv {
    API_ORIGIN: string
  }
  const factoryDecl = definePage<MyEnv>((env) => ({
    api: { serverUrl: env.API_ORIGIN, browserUrl: '/v2/api' },
  }))
  const resolvedFactory = resolvePageConfig(
    factoryDecl,
    { API_ORIGIN: 'http://env-backend:9000' },
    '/api',
  )
  expect(resolvedFactory?.api?.serverUrl).toBe('http://env-backend:9000')
  expect(resolvedFactory?.api?.browserUrl).toBe('/v2/api')
})
