import { expect, it } from 'vitest'

import { getCurrentScope } from '../../src/core/context'
import { createDefinition } from '../../src/entries/runtime/core'
import {
  type AppConfig,
  type AppInstance,
  createApp,
  defineApp,
  route,
} from '../../src/entries/server'
import { parseApiFilePath } from '../../src/http/path'
import {
  compileProxyRules,
  matchesCompiledRules,
  resolveClientIp,
  resolveExternalOrigin,
  validateHost,
} from '../../src/http/proxy'
import type { RouteEntry } from '../../src/http/server/types'

async function withApp(
  config: AppConfig,
  routes: RouteEntry[],
  run: (app: AppInstance) => Promise<void>,
) {
  const app = await createApp(createDefinition({ app: defineApp(config), routes }))
  try {
    await run(app)
  } finally {
    await app.close()
  }
}
it('matches CIDRs and predefined ranges for loopback and private networks', () => {
  // Loopback
  expect(matchesCompiledRules('127.0.0.1', compileProxyRules(['loopback']))).toBe(true)
  expect(matchesCompiledRules('127.0.0.2', compileProxyRules(['loopback']))).toBe(true)
  expect(matchesCompiledRules('::1', compileProxyRules(['loopback']))).toBe(true)
  expect(matchesCompiledRules('::ffff:127.0.0.1', compileProxyRules(['loopback']))).toBe(true)
  expect(matchesCompiledRules('192.168.1.1', compileProxyRules(['loopback']))).toBe(false)

  // Private networks
  expect(matchesCompiledRules('10.0.5.1', compileProxyRules(['private']))).toBe(true)
  expect(matchesCompiledRules('172.16.10.20', compileProxyRules(['private']))).toBe(true)
  expect(matchesCompiledRules('192.168.0.1', compileProxyRules(['private']))).toBe(true)
  expect(matchesCompiledRules('fc00::1', compileProxyRules(['private']))).toBe(true)
  expect(matchesCompiledRules('8.8.8.8', compileProxyRules(['private']))).toBe(false)

  // Custom CIDR and exact IP
  expect(matchesCompiledRules('203.0.113.42', compileProxyRules(['203.0.113.0/24']))).toBe(true)
  expect(matchesCompiledRules('203.0.114.1', compileProxyRules(['203.0.113.0/24']))).toBe(false)
  expect(matchesCompiledRules('198.51.100.1', compileProxyRules(['198.51.100.1']))).toBe(true)
})

it('discards X-Forwarded-For if the direct peer is not trusted', () => {
  const headers = new Headers({
    'x-forwarded-for': '203.0.113.1, 10.0.0.1',
  })
  const peerIp = '198.51.100.25' // untrusted public IP
  const clientIp = resolveClientIp(headers, peerIp, compileProxyRules(['loopback', 'private']))
  expect(clientIp).toBe('198.51.100.25')
})

it('resolves client IP by traversing right-to-left across trusted proxies', () => {
  const peerIp = '127.0.0.1' // trusted loopback proxy
  const headers = new Headers({
    'x-forwarded-for': '203.0.113.50, 10.0.0.2, 172.16.0.1',
  })

  // Both 172.16.0.1 and 10.0.0.2 are trusted private proxies.
  // 203.0.113.50 is public (untrusted).
  // Traversal stops at 203.0.113.50.
  const clientIp = resolveClientIp(headers, peerIp, compileProxyRules(['loopback', 'private']))
  expect(clientIp).toBe('203.0.113.50')
})

it('returns the leftmost IP if all hops are trusted proxies', () => {
  const peerIp = '127.0.0.1'
  const headers = new Headers({
    'x-forwarded-for': '10.0.0.1, 10.0.0.2, 10.0.0.3',
  })
  const clientIp = resolveClientIp(headers, peerIp, compileProxyRules(['loopback', 'private']))
  expect(clientIp).toBe('10.0.0.1')
})

it('validates Host header against whitelist and wildcard patterns', () => {
  // Pass: exact match
  expect(() => validateHost('example.com', ['example.com'])).not.toThrow()
  // Pass: port is ignored
  expect(() => validateHost('example.com:8080', ['example.com'])).not.toThrow()
  // Pass: wildcard pattern
  expect(() => validateHost('api.example.com', ['*.example.com'])).not.toThrow()
  expect(() => validateHost('deep.sub.example.com', ['*.example.com'])).not.toThrow()

  // Fail: mismatched host
  expect(() => validateHost('evil.com', ['example.com', '*.example.com'])).toThrowError()
  try {
    validateHost('evil.com', ['example.com'])
  } catch (err: any) {
    expect(err.status).toBe(400)
    expect(err.code).toBe('invalid_host')
  }

  // Fail: missing host
  expect(() => validateHost('', ['example.com'])).toThrowError()
  expect(() => validateHost(null, ['example.com'])).toThrowError()
})

it('resolves external origin from proxy headers only if peer is trusted', () => {
  const reqUrl = new URL('http://127.0.0.1:3000/api/users')
  const headers = new Headers({
    'x-forwarded-proto': 'https',
    'x-forwarded-host': 'api.production.example',
  })

  // 1. Trusted peer resolves to external origin
  const trustedOrigin = resolveExternalOrigin(
    reqUrl,
    headers,
    '127.0.0.1',
    compileProxyRules(['loopback']),
  )
  expect(trustedOrigin.origin).toBe('https://api.production.example')

  // 2. Untrusted peer ignores forwarded headers
  const untrustedOrigin = resolveExternalOrigin(
    reqUrl,
    headers,
    '203.0.113.1',
    compileProxyRules(['loopback']),
  )
  expect(untrustedOrigin.origin).toBe('http://127.0.0.1:3000')
})

it('rejects requests with disallowed Host header through the application pipeline', async () => {
  const routes: RouteEntry[] = [
    {
      routePath: parseApiFilePath('status.get.ts', '/api')!,
      declaration: route().handler(() => ({ status: 'ok' })),
    },
  ]

  await withApp(
    {
      hosts: ['api.legit.example', '*.corp.example'],
    },
    routes,
    async (app) => {
      // Disallowed host receives 400 invalid_host
      const blockedRes = await app.fetch(
        new Request('http://localhost/api/status', {
          headers: { Host: 'evil.attacker.example' },
        }),
      )
      expect(blockedRes.status).toBe(400)
      const blockedBody = await blockedRes.json()
      expect(blockedBody.error.code).toBe('invalid_host')

      // Allowed host passes
      const okRes = await app.fetch(
        new Request('http://localhost/api/status', {
          headers: { Host: 'api.legit.example' },
        }),
      )
      expect(okRes.status).toBe(200)

      // Wildcard host passes
      const wildcardRes = await app.fetch(
        new Request('http://localhost/api/status', {
          headers: { Host: 'auth.corp.example:8443' },
        }),
      )
      expect(wildcardRes.status).toBe(200)
    },
  )
})

it('extracts peer socket remoteAddress from Node server environment and discards spoofed proxy headers', async () => {
  let observedClientIp: string | undefined

  const routes: RouteEntry[] = [
    {
      routePath: parseApiFilePath('ip.get.ts', '/api')!,
      declaration: route().handler(() => {
        observedClientIp = getCurrentScope()?.clientIp
        return { ip: observedClientIp }
      }),
    },
  ]

  await withApp(
    {
      trustedProxies: ['loopback'],
    },
    routes,
    async (app) => {
      // Simulate @hono/node-server passing { incoming: { socket: { remoteAddress: '203.0.113.195' } } }
      const mockNodeEnv = {
        incoming: {
          socket: {
            remoteAddress: '203.0.113.195',
          },
        },
      }

      const req = new Request('http://localhost:3000/api/ip', {
        headers: {
          'X-Forwarded-For': '1.1.1.1, 8.8.8.8',
        },
      })

      const res = await app.fetch(req, mockNodeEnv)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ip: '203.0.113.195' })
      expect(observedClientIp).toBe('203.0.113.195')
    },
  )
})

it('does not infer a trusted peer from the destination URL during in-memory dispatch', async () => {
  await withApp(
    {},
    [
      {
        routePath: parseApiFilePath('origin.get.ts', '/api')!,
        declaration: route().handler(() => ({ origin: getCurrentScope()?.externalOrigin })),
      },
    ],
    async (app) => {
      const response = await app.fetch(
        new Request('http://127.0.0.1:3000/api/origin', {
          headers: { 'X-Forwarded-Host': 'unverified.example', 'X-Forwarded-Proto': 'https' },
        }),
      )
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ origin: 'http://127.0.0.1:3000' })
    },
  )
})

it('rejects ::2 from loopback, matches mapped IPv6 CIDR, and handles IPv6 host validation and external port', () => {
  // A. IPv6 loopback contains ::1, not neighboring addresses.
  expect(matchesCompiledRules('::2', compileProxyRules(['loopback']))).toBe(false)
  expect(matchesCompiledRules('::1', compileProxyRules(['loopback']))).toBe(true)
  expect(matchesCompiledRules('127.0.0.1', compileProxyRules(['loopback']))).toBe(true)
  expect(matchesCompiledRules('::ffff:127.0.0.1', compileProxyRules(['loopback']))).toBe(true)

  // B. IPv4-mapped address ::ffff:10.0.0.5 matches ::ffff:10.0.0.0/104
  expect(matchesCompiledRules('::ffff:10.0.0.5', compileProxyRules(['::ffff:10.0.0.0/104']))).toBe(
    true,
  )
  expect(matchesCompiledRules('::ffff:11.0.0.5', compileProxyRules(['::ffff:10.0.0.0/104']))).toBe(
    false,
  )

  // C. validateHost parses bracketed IPv6 host without truncating
  expect(() => validateHost('[::1]:3000', ['[::1]'])).not.toThrow()
  expect(() => validateHost('[::1]', ['[::1]'])).not.toThrow()
  expect(() => validateHost('[::2]:3000', ['[::1]'])).toThrow()

  // D. resolveExternalOrigin preserves X-Forwarded-Port
  const reqUrl = new URL('http://127.0.0.1:3000/api/test')
  const headers = new Headers({
    'x-forwarded-proto': 'https',
    'x-forwarded-host': 'example.com',
    'x-forwarded-port': '8443',
  })
  const origin = resolveExternalOrigin(
    reqUrl,
    headers,
    '127.0.0.1',
    compileProxyRules(['loopback']),
  )
  expect(origin.origin).toBe('https://example.com:8443')

  // E. resolveClientIp traverses right-to-left across trusted proxies
  const xffHeaders = new Headers({ 'x-forwarded-for': '203.0.113.195, 127.0.0.1' })
  expect(resolveClientIp(xffHeaders, '127.0.0.1', compileProxyRules(['loopback']))).toBe(
    '203.0.113.195',
  )
})
