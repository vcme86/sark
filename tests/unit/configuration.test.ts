import { resolve } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { defineNodeRuntime, resolveNodeRuntime } from '../../src/adapter/node/runtime'
import { createDefinition } from '../../src/entries/runtime/core'
import { createApp, defineApp } from '../../src/entries/server'
import { resolveProjectConfig, resolveSarkOptions } from '../../src/tooling/config'
import { type HttpConfig, resolveHttpConfig } from '../../src/web/http/config'
import { computeEffectivePolicy } from '../../src/web/http/server/policy'

afterEach(() => vi.unstubAllEnvs())

describe('engineering configuration', () => {
  it('normalizes prefixes once and binds all discovery paths to the supplied root', () => {
    const options = resolveSarkOptions({
      appEntry: 'config/app.ts',
      apiDir: 'handlers',
      apiPrefix: '/service//v2/',
      webDir: false,
      webPrefix: '/site//articles/',
      generatedDir: 'generated/server',
      target: undefined,
    })
    expect(options.apiPrefix).toBe('/service/v2')
    expect(options.target).toBe('node')
    expect(options.webDir).toBe(false)
    expect(options.webPrefix).toBe('/site/articles')
    const project = resolveProjectConfig('/example', options)
    expect(project.appEntryPath).toBe(resolve('/example/config/app.ts'))
    expect(project.apiDir).toBe(resolve('/example/handlers'))
    expect(project.generatedDir).toBe(resolve('/example/generated/server'))
    expect(project.options).toBe(options)
    expect(resolveProjectConfig('/example', resolveSarkOptions({ apiDir: false })).apiDir).toBe(
      false,
    )
  })

  it.each(['api', '//example.test', '/api?version=2', '/api/../private'])(
    'rejects an invalid API prefix: %s',
    (apiPrefix) => expect(() => resolveSarkOptions({ apiPrefix })).toThrow(/apiPrefix/),
  )

  it('rejects null rather than restoring a default', () => {
    // @ts-expect-error JavaScript callers can supply values outside the public type.
    expect(() => resolveSarkOptions({ apiDir: null })).toThrow(/apiDir/)
  })
})

describe('HTTP configuration and local inheritance', () => {
  it('merges partial objects and retains explicit disabled policies, zero and empty arrays', () => {
    vi.stubEnv('NODE_ENV', 'production')
    const input: HttpConfig = {
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
      'x-frame-options': false,
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

  it.each(['unknown-proxy', '192.168.0.0/33', '10.0.0.0/8extra'])(
    'rejects invalid trusted proxy configuration before request handling: %s',
    async (rule) => {
      await expect(
        createApp(
          createDefinition({
            app: defineApp({ trustedProxies: [rule] }),
          }),
        ),
      ).rejects.toThrow(/http.trustedProxies/)
    },
  )

  it('does not treat null Cookie settings as omitted', () => {
    // @ts-expect-error Invalid JavaScript input must fail at the owner boundary.
    expect(() => resolveHttpConfig({ cookie: { secure: null } })).toThrow(/Cookie/)
    // @ts-expect-error Null is not an allowed Cookie configuration.
    expect(() => resolveHttpConfig({ cookie: null })).toThrow(/cookie/)
  })

  it('evaluates declaration factories once per instance after environment is available', async () => {
    const factory = vi.fn((env: { limit: number }) => ({ bodyLimit: env.limit }))
    const definition = createDefinition({ app: defineApp(factory) })
    expect(factory).not.toHaveBeenCalled()
    const first = await createApp(definition, { env: { limit: 4 } })
    const second = await createApp(definition, { env: { limit: 9 } })
    try {
      expect(first.config.bodyLimit).toBe(4)
      expect(second.config.bodyLimit).toBe(9)
      await first.fetch(new Request('https://example.test/missing'))
      expect(factory).toHaveBeenCalledTimes(2)
    } finally {
      await Promise.all([first.close(), second.close()])
    }
  })
})

describe('Node runtime configuration', () => {
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
    expect(resolveNodeRuntime(defineNodeRuntime({ compress: false, probes: false }))).toMatchObject(
      { compress: false, probes: false },
    )
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
})
