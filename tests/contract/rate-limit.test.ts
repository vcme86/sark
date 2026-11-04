import { describe, expect, it, vi } from 'vitest'

import { createWorkerHandler } from '../../src/adapter/cloudflare/runtime'
import { rateLimit } from '../../src/entries/middleware'
import { createApp, defineApp, route } from '../../src/entries/root'
import { createDefinition } from '../../src/entries/runtime/core'
import { parseApiFilePath } from '../../src/http/path'
import { createRateLimitAssembly } from '../../src/middleware/rate-limit/assembly'
import { defineRateLimit } from '../../src/middleware/rate-limit/declaration'
import { NodeRateLimiter } from '../../src/middleware/rate-limit/node'

describe('rate limit contract', () => {
  it('enforces in-memory bounded fixed-window counter, emits headers, and rejects on exceeded limit', () => {
    const limiter = new NodeRateLimiter({
      kind: 'node',
      headers: true,
      maxKeys: 10000,
      limit: 3,
      window: 1000,
    })

    const key = '127.0.0.1'

    const r1 = limiter.check(key)
    expect(r1.allowed).toBe(true)
    expect(r1.limit).toBe(3)
    expect(r1.remaining).toBe(2)
    expect(r1.resetSeconds).toBeGreaterThanOrEqual(1)

    const r2 = limiter.check(key)
    expect(r2.allowed).toBe(true)
    expect(r2.remaining).toBe(1)

    const r3 = limiter.check(key)
    expect(r3.allowed).toBe(true)
    expect(r3.remaining).toBe(0)

    // 4th request exceeds quota
    const r4 = limiter.check(key)
    expect(r4.allowed).toBe(false)
    expect(r4.remaining).toBe(0)
    expect(r4.resetSeconds).toBeGreaterThanOrEqual(1)
  })

  it('rejects invalid maxKeys at the public rateLimit boundary', () => {
    expect(() => rateLimit({ limit: 2, window: 1000, maxKeys: 2.5 })).toThrow(
      'Node rate limit "maxKeys" must be a positive integer.',
    )
    expect(() => rateLimit({ limit: 2, window: 1000, maxKeys: 0 })).toThrow(
      'Node rate limit "maxKeys" must be a positive integer.',
    )
  })

  it('evicts expired entries on access before evicting active keys', async () => {
    const limiter = new NodeRateLimiter({
      kind: 'node',
      headers: true,
      limit: 2,
      window: 30, // 30ms window
      maxKeys: 2,
    })

    limiter.check('key-a')
    limiter.check('key-b')
    expect(limiter.size).toBe(2)

    // Wait for window to expire
    await new Promise((r) => setTimeout(r, 40))

    // Inserting key-c sweeps expired keys (key-a and key-b)
    const fresh = limiter.check('key-c')
    expect(fresh.allowed).toBe(true)
    expect(limiter.size).toBe(1)
  })

  it('evicts oldest keys when maxKeys capacity is reached with unexpired keys', () => {
    const limiter = new NodeRateLimiter({
      kind: 'node',
      headers: true,
      limit: 5,
      window: 60000,
      maxKeys: 3,
    })

    limiter.check('ip-1')
    limiter.check('ip-2')
    limiter.check('ip-3')
    expect(limiter.size).toBe(3)

    // Inserting 4th key evicts the oldest (ip-1)
    limiter.check('ip-4')
    expect(limiter.size).toBe(3)
  })

  it('merges declarative route overrides and handles rateLimit: false', async () => {
    const app = await createApp(
      createDefinition({
        admission: createRateLimitAssembly(
          defineRateLimit({
            limit: 2,
            window: 1000,
          }),
        ),
        routes: [
          // Inherits app limit: 2
          {
            source: 'api/default.ts',
            routePath: parseApiFilePath('api/default.get.ts', '/')!,
            declaration: route().handler((ctx) => ctx.text('default')),
          },
          // Route override: relaxed to limit 4
          {
            source: 'api/relaxed.ts',
            routePath: parseApiFilePath('api/relaxed.get.ts', '/')!,
            declaration: route({ rateLimit: { limit: 4, window: 1000 } }).handler((ctx) =>
              ctx.text('relaxed'),
            ),
          },
          // Route override: disabled with false
          {
            source: 'api/webhook.ts',
            routePath: parseApiFilePath('api/webhook.post.ts', '/')!,
            declaration: route({ rateLimit: false }).handler((ctx) => ctx.text('webhook')),
          },
        ],
      }),
    )

    try {
      // 1. /api/default enforces limit: 2
      const d1 = await app.fetch(new Request('http://localhost/api/default'))
      expect(d1.status).toBe(200)
      expect(d1.headers.get('RateLimit-Remaining')).toBe('1')

      const d2 = await app.fetch(new Request('http://localhost/api/default'))
      expect(d2.status).toBe(200)
      expect(d2.headers.get('RateLimit-Remaining')).toBe('0')

      const d3 = await app.fetch(new Request('http://localhost/api/default'))
      expect(d3.status).toBe(429)
      expect(d3.headers.get('Retry-After')).toBeTruthy()

      // 2. /api/relaxed allows 4 requests
      for (let i = 0; i < 4; i++) {
        const res = await app.fetch(new Request('http://localhost/api/relaxed'))
        expect(res.status).toBe(200)
      }
      const r5 = await app.fetch(new Request('http://localhost/api/relaxed'))
      expect(r5.status).toBe(429)

      // 3. /api/webhook is exempt (rateLimit: false)
      for (let i = 0; i < 10; i++) {
        const res = await app.fetch(
          new Request('http://localhost/api/webhook', {
            method: 'POST',
            headers: { Origin: 'http://localhost' },
          }),
        )
        expect(res.status).toBe(200)
        expect(res.headers.get('RateLimit-Limit')).toBeNull()
      }
    } finally {
      await app.close()
    }
  })

  it('throws configuration error when route/scope declares rateLimit without application defineRateLimit', async () => {
    await expect(
      createApp(
        createDefinition({
          routes: [
            {
              source: 'api/test.ts',
              routePath: parseApiFilePath('api/test.get.ts', '/')!,
              declaration: route({ rateLimit: { limit: 10, window: 1000 } }).handler((ctx) =>
                ctx.text('test'),
              ),
            },
          ],
        }),
      ),
    ).rejects.toThrow('Cannot declare route/scope rateLimit without application defineRateLimit.')
  })

  it('executes declarative rate limiting and explicit middleware independently', async () => {
    // Declarative limit: 1, Explicit middleware limit: 10
    const explicitMw = rateLimit({ limit: 10, window: 1000 })

    const app = await createApp(
      createDefinition({
        admission: createRateLimitAssembly(defineRateLimit({ limit: 1, window: 1000 })),
        routes: [
          {
            source: 'api/dual.ts',
            routePath: parseApiFilePath('api/dual.get.ts', '/')!,
            declaration: route({ middleware: [explicitMw] }).handler((ctx) => ctx.text('ok')),
          },
        ],
      }),
    )

    try {
      const r1 = await app.fetch(new Request('http://localhost/api/dual'))
      expect(r1.status).toBe(200)

      // Second request is blocked by declarative limit (limit: 1), even though explicit middleware allows 10!
      const r2 = await app.fetch(new Request('http://localhost/api/dual'))
      expect(r2.status).toBe(429)
    } finally {
      await app.close()
    }
  })

  it('exempts internal fetch calls from external rate limit quotas', async () => {
    let app: any
    app = await createApp(
      createDefinition({
        admission: createRateLimitAssembly(defineRateLimit({ limit: 1, window: 1000 })),
        routes: [
          {
            source: 'api/internal-target.ts',
            routePath: parseApiFilePath('api/internal-target.get.ts', '/')!,
            declaration: route().handler((ctx) => ctx.text('data')),
          },
          {
            source: 'api/caller.ts',
            routePath: parseApiFilePath('api/caller.get.ts', '/')!,
            declaration: route({ rateLimit: false }).handler(async () => {
              // Call the rate-limited endpoint multiple times internally
              const res1 = await app.fetchInternal(
                new Request('http://localhost/api/internal-target'),
              )
              const res2 = await app.fetchInternal(
                new Request('http://localhost/api/internal-target'),
              )
              return {
                s1: res1.status,
                s2: res2.status,
              }
            }),
          },
        ],
      }),
    )

    try {
      const res = await app.fetch(new Request('http://localhost/api/caller'))
      expect(await res.json()).toEqual({ s1: 200, s2: 200 })
    } finally {
      await app.close()
    }
  })

  it('evaluates rateLimit environment factory per event and respects dynamic Worker bindings', async () => {
    let checkedBindingName: string | undefined

    const limiterA = {
      limit: vi.fn(async () => {
        checkedBindingName = 'A'
        return { success: true }
      }),
    }

    const limiterB = {
      limit: vi.fn(async () => {
        checkedBindingName = 'B'
        return { success: true }
      }),
    }

    const definition = createDefinition({
      app: defineApp({}),
      admission: createRateLimitAssembly(
        defineRateLimit((env: any) => ({
          binding: env.CURRENT_BINDING,
        })),
      ),
      routes: [
        {
          source: 'api/worker-rl.ts',
          routePath: parseApiFilePath('api/worker-rl.get.ts', '/')!,
          declaration: route().handler((ctx) => ctx.text('ok')),
        },
      ],
    })

    const handler = createWorkerHandler(definition)
    const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() }

    // Event 1 with binding A
    const resA = await handler.fetch(
      new Request('https://worker.example.com/api/worker-rl'),
      { CURRENT_BINDING: 'LIMITER_A', LIMITER_A: limiterA },
      ctx,
    )
    expect(resA.status).toBe(200)
    expect(checkedBindingName).toBe('A')

    // Event 2 with binding B
    const resB = await handler.fetch(
      new Request('https://worker.example.com/api/worker-rl'),
      { CURRENT_BINDING: 'LIMITER_B', LIMITER_B: limiterB },
      ctx,
    )
    expect(resB.status).toBe(200)
    expect(checkedBindingName).toBe('B')
  })
})

it('shares inherited counting across empty, undefined and header-only overrides, including unmatched requests', async () => {
  const routes = [
    {
      source: 'one.get.ts',
      routePath: parseApiFilePath('one.get.ts', '/')!,
      declaration: route({ rateLimit: {} }).handler(() => null),
    },
    {
      source: 'two.get.ts',
      routePath: parseApiFilePath('two.get.ts', '/')!,
      declaration: route({ rateLimit: { headers: false, limit: undefined } }).handler(() => null),
    },
  ]
  const app = await createApp(
    createDefinition({
      admission: createRateLimitAssembly(defineRateLimit({ limit: 2, window: 60000 })),
      routes,
    }),
  )
  try {
    expect((await app.fetch(new Request('http://localhost/one'))).status).toBe(200)
    const second = await app.fetch(new Request('http://localhost/two'))
    expect(second.status).toBe(200)
    expect(second.headers.has('RateLimit-Limit')).toBe(false)
    expect((await app.fetch(new Request('http://localhost/missing'))).status).toBe(429)
    expect((await app.fetch(new Request('http://localhost/one'))).status).toBe(429)
  } finally {
    await app.close()
  }
})

it('limits unmatched requests without applying endpoint CSRF or body-limit policies', async () => {
  const app = await createApp(
    createDefinition({
      app: defineApp({ csrf: true, bodyLimit: 2 }),
      admission: createRateLimitAssembly(defineRateLimit({ limit: 2, window: 60000 })),
      routes: [
        {
          routePath: parseApiFilePath('known.get.ts', '/')!,
          declaration: route().handler(() => null),
        },
      ],
    }),
  )
  try {
    for (const [path, origin, expected] of [
      ['/missing', 'https://other.example', 404],
      ['/known', 'http://localhost', 405],
    ] as const) {
      const response = await app.fetch(
        new Request(`http://localhost${path}`, {
          method: 'POST',
          headers: { origin, 'content-type': 'text/plain', 'content-length': '9' },
          body: 'oversized',
        }),
      )
      expect(response.status).toBe(expected)
      await response.text()
    }
    const limited = await app.fetch(new Request('http://localhost/missing'))
    expect(limited.status).toBe(429)
    await limited.text()
  } finally {
    await app.close()
  }
})

it('uses scope defaults per route and supports re-enabling a disabled scope', async () => {
  const scope = { options: { rateLimit: { limit: 1 } } }
  const app = await createApp(
    createDefinition({
      admission: createRateLimitAssembly(defineRateLimit({ limit: 9, window: 60000 })),
      routes: ['one', 'two', 'three'].map((name) => ({
        routePath: parseApiFilePath(`${name}.get.ts`, '/')!,
        scopes: name === 'three' ? [{ options: { rateLimit: false } }] : [scope],
        declaration: route(name === 'three' ? { rateLimit: { limit: 1 } } : {}).handler(() => null),
      })),
    }),
  )
  try {
    for (const path of ['one', 'two', 'three']) {
      expect((await app.fetch(new Request(`http://localhost/${path}`))).status).toBe(200)
      expect((await app.fetch(new Request(`http://localhost/${path}`))).status).toBe(429)
    }
  } finally {
    await app.close()
  }
})

it('applies the Worker binding to unmatched requests without duplicate counting', async () => {
  const binding = { limit: vi.fn(async () => ({ success: false })) }
  const handler = createWorkerHandler(
    createDefinition({
      admission: createRateLimitAssembly(defineRateLimit({ binding: 'LIMITER' })),
      routes: [],
    }),
  )
  const work: Promise<unknown>[] = []
  const response = await handler.fetch(
    new Request('https://example.test/missing'),
    { LIMITER: binding },
    { waitUntil: (promise) => work.push(promise), passThroughOnException() {} },
  )
  expect(response.status).toBe(429)
  await response.text()
  await Promise.all(work)
  expect(binding.limit).toHaveBeenCalledOnce()
})
