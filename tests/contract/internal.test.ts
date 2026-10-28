import { expect, it } from 'vitest'

import { getCurrentScope } from '../../src/core/context'
import { createDefinition } from '../../src/entries/runtime/core'
import {
  createApp,
  dedup,
  defineApp,
  HttpError,
  route,
  setCookie,
  z,
} from '../../src/entries/server'
import { parseApiFilePath } from '../../src/http/path'
import type { RouteDeclaration } from '../../src/http/types'

const entry = (file: string, declaration: RouteDeclaration) => ({
  routePath: parseApiFilePath(file, '/api')!,
  declaration,
})

const crossOriginPost = () =>
  new Request('http://localhost/api/private', {
    method: 'POST',
    headers: {
      Origin: 'https://foreign.example',
      'Content-Type': 'text/plain',
      'X-Sark-Internal': 'true',
    },
    body: 'hello',
  })

it('inherits request ID and dedup across nested internal calls, without sharing across requests', async () => {
  let calls = 0
  const load = dedup(async (id: number) => ({ id, call: ++calls }))
  const app = await createApp(
    createDefinition({
      routes: [
        entry(
          'outer.get.ts',
          route().handler(async (): Promise<unknown> => {
            const loaded = await load(1)
            const inner = await app.fetchInternal(
              new Request('http://localhost/api/inner', { headers: { 'X-Request-Id': 'inner' } }),
            )
            return {
              loaded,
              inner: await inner.json(),
              requestId: inner.headers.get('X-Request-Id'),
            }
          }),
        ),
        entry(
          'inner.get.ts',
          route().handler(async () => ({
            loaded: await load(1),
            requestId: getCurrentScope()?.requestId,
          })),
        ),
      ],
    }),
  )
  try {
    for (const call of [1, 2]) {
      const suppliedId = `outer-${call}`
      const response = await app.fetch(
        new Request('http://localhost/api/outer', { headers: { 'X-Request-Id': suppliedId } }),
      )
      const requestId = response.headers.get('X-Request-Id')
      expect(requestId).toBeTruthy()
      expect(await response.json()).toEqual({
        loaded: { id: 1, call },
        inner: { loaded: { id: 1, call }, requestId },
        requestId,
      })
    }
    expect(calls).toBe(2)
  } finally {
    await app.close()
  }
})

it('skips internal CORS and CSRF while retaining validation, authorization and body limits', async () => {
  const observed: string[] = []
  const handled: string[] = []
  let corsCalls = 0
  const app = await createApp(
    createDefinition({
      app: defineApp({
        cors: {
          origin: () => {
            corsCalls++
            return 'https://frontend.example'
          },
        },
        bodyLimit: 8,
        middleware: [
          async (ctx, next) => {
            observed.push(ctx.req.path)
            await next()
          },
        ],
      }),
      routes: [
        entry(
          'outer.get.ts',
          route().handler(async (): Promise<unknown> => {
            const results = []
            for (const [path, body] of [
              ['write', 'ok'],
              ['write', ''],
              ['write', 'too much data'],
              ['private', 'ok'],
            ]) {
              const response = await app.fetchInternal(
                new Request(`http://localhost/api/${path}`, {
                  method: 'POST',
                  headers: { Origin: 'https://foreign.example', 'Content-Type': 'text/plain' },
                  body,
                }),
              )
              results.push({
                status: response.status,
                cors: response.headers.get('Access-Control-Allow-Origin'),
              })
            }
            return results
          }),
        ),
        entry(
          'write.post.ts',
          route()
            .validate({ text: z.string().min(1) })
            .handler((_ctx, input) => {
              handled.push(input.text)
              return input.text
            }),
        ),
        entry(
          'private.post.ts',
          route({ middleware: [async (ctx) => ctx.text('Denied', 403)] }).handler(() => 'private'),
        ),
      ],
    }),
  )
  try {
    const response = await app.fetch(new Request('http://localhost/api/outer'))
    expect(await response.json()).toEqual([
      { status: 200, cors: null },
      { status: 400, cors: null },
      { status: 413, cors: null },
      { status: 403, cors: null },
    ])
    expect(corsCalls).toBe(1)
    expect(observed).toEqual([
      '/api/outer',
      '/api/write',
      '/api/write',
      '/api/write',
      '/api/private',
    ])
    expect(handled).toEqual(['ok'])
  } finally {
    await app.close()
  }
})

it('propagates outer cancellation to the internal request and execution scope', async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const controller = new AbortController()
  let scopeSignal: AbortSignal | undefined
  let requestSignal: AbortSignal | undefined
  const app = await createApp(
    createDefinition({
      routes: [
        entry(
          'outer.get.ts',
          route().handler(async (): Promise<unknown> => {
            const response = await app.fetchInternal(new Request('http://localhost/api/inner'))
            return response.text()
          }),
        ),
        entry(
          'inner.get.ts',
          route().handler(async (ctx) => {
            scopeSignal = getCurrentScope()?.signal
            requestSignal = ctx.req.raw.signal
            entered.resolve()
            await release.promise
            return 'done'
          }),
        ),
      ],
    }),
  )
  const pending = app.fetch(
    new Request('http://localhost/api/outer', { signal: controller.signal }),
  )
  try {
    await entered.promise
    const reason = new Error('Client disconnected')
    controller.abort(reason)
    expect(scopeSignal?.aborted).toBe(true)
    expect(scopeSignal?.reason).toBe(reason)
    expect(requestSignal?.aborted).toBe(true)
    expect(requestSignal?.reason).toBe(reason)
  } finally {
    release.resolve()
    await pending
    await app.close()
  }
})

it('also propagates cancellation supplied by the internal caller', async () => {
  const controller = new AbortController()
  const app = await createApp(
    createDefinition({
      routes: [
        entry(
          'outer.get.ts',
          route().handler(async (): Promise<unknown> => {
            const reason = new Error('Internal operation cancelled')
            controller.abort(reason)
            const response = await app.fetchInternal(
              new Request('http://localhost/api/inner', { signal: controller.signal }),
            )
            return response.json()
          }),
        ),
        entry(
          'inner.get.ts',
          route().handler((ctx) => ({
            request: ctx.req.raw.signal.aborted,
            scope: getCurrentScope()?.signal?.aborted,
          })),
        ),
      ],
    }),
  )
  try {
    expect(await (await app.fetch(new Request('http://localhost/api/outer'))).json()).toEqual({
      request: true,
      scope: true,
    })
  } finally {
    await app.close()
  }
})

it.each([false, true])(
  'collects nested internal cookies without duplicating a forwarded response (forward=%s)',
  async (forward) => {
    const app = await createApp(
      createDefinition({
        routes: [
          entry(
            'outer.get.ts',
            route().handler(async (ctx): Promise<unknown> => {
              setCookie(ctx, 'outer', 'one')
              const response = await app.fetchInternal(new Request('http://localhost/api/middle'))
              return forward ? response : { ok: response.ok }
            }),
          ),
          entry(
            'middle.get.ts',
            route().handler(async (ctx): Promise<Response> => {
              setCookie(ctx, 'middle', 'two')
              return app.fetchInternal(new Request('http://localhost/api/inner'))
            }),
          ),
          entry(
            'inner.get.ts',
            route().handler(() => {
              const headers = new Headers()
              headers.append(
                'Set-Cookie',
                'part=one; Path=/one; Expires=Wed, 21 Oct 2037 07:28:00 GMT',
              )
              headers.append('Set-Cookie', 'part=two; Path=/two')
              return new Response('done', { headers })
            }),
          ),
        ],
      }),
    )
    try {
      const response = await app.fetch(new Request('http://localhost/api/outer'))
      expect(response.headers.getSetCookie()).toEqual([
        'outer=one; Path=/; SameSite=Lax',
        'middle=two; Path=/; SameSite=Lax',
        'part=one; Path=/one; Expires=Wed, 21 Oct 2037 07:28:00 GMT',
        'part=two; Path=/two',
      ])
    } finally {
      await app.close()
    }
  },
)

it('does not grant internal privileges to external, standalone or other-application dispatch', async () => {
  const other = await createApp(
    createDefinition({
      routes: [
        entry(
          'private.post.ts',
          route().handler(() => 'private'),
        ),
      ],
    }),
  )
  const app = await createApp(
    createDefinition({
      routes: [
        entry(
          'outer.get.ts',
          route().handler(async (): Promise<unknown> =>
            (await app.fetchInternal(new Request('http://localhost/api/inner'))).json(),
          ),
        ),
        entry(
          'inner.get.ts',
          route().handler(async (): Promise<{ external: number; other: number }> => ({
            external: (await app.fetch(crossOriginPost())).status,
            other: (await other.fetchInternal(crossOriginPost())).status,
          })),
        ),
        entry(
          'private.post.ts',
          route().handler(() => 'private'),
        ),
      ],
    }),
  )
  try {
    expect((await app.fetchInternal(crossOriginPost())).status).toBe(403)
    const response = await app.fetch(new Request('http://localhost/api/outer'))
    expect(await response.json()).toEqual({ external: 403, other: 403 })
  } finally {
    await Promise.all([app.close(), other.close()])
  }
})

it('preserves cookie write order before, during and after internal dispatch', async () => {
  const app = await createApp(
    createDefinition({
      routes: [
        entry(
          'outer.get.ts',
          route().handler(async (ctx): Promise<unknown> => {
            setCookie(ctx, 'mode', 'before')
            await app.fetchInternal(new Request('http://localhost/api/inner'))
            setCookie(ctx, 'mode', 'after')
            return 'done'
          }),
        ),
        entry(
          'inner.get.ts',
          route().handler((ctx) => {
            setCookie(ctx, 'mode', 'internal')
            return 'done'
          }),
        ),
      ],
    }),
  )
  try {
    const response = await app.fetch(new Request('http://localhost/api/outer'))
    expect(response.headers.getSetCookie()).toEqual([
      'mode=before; Path=/; SameSite=Lax',
      'mode=internal; Path=/; SameSite=Lax',
      'mode=after; Path=/; SameSite=Lax',
    ])
  } finally {
    await app.close()
  }
})

it.each(['handler', 'global middleware', 'route middleware', 'error'])(
  'retains cookies from an explicit %s response after internal dispatch',
  async (source) => {
    async function respond(): Promise<Response> {
      await app.fetchInternal(new Request('http://localhost/api/inner'))
      const headers = { 'Set-Cookie': 'outer=two; Path=/', 'X-Result': 'created' }
      if (source === 'error') throw new HttpError(409, 'Conflict', { headers })
      return new Response('created', { status: 201, headers })
    }
    const app = await createApp(
      createDefinition({
        app: defineApp({
          middleware:
            source === 'global middleware'
              ? [async (ctx, next) => (ctx.req.path === '/api/outer' ? respond() : next())]
              : [],
        }),
        routes: [
          entry(
            'outer.get.ts',
            route({ middleware: source === 'route middleware' ? [respond] : [] }).handler(respond),
          ),
          entry(
            'inner.get.ts',
            route().handler((ctx) => {
              setCookie(ctx, 'inner', 'one')
              return 'done'
            }),
          ),
        ],
      }),
    )
    try {
      const response = await app.fetch(new Request('http://localhost/api/outer'))
      expect(response.headers.getSetCookie()).toEqual([
        'inner=one; Path=/; SameSite=Lax',
        'outer=two; Path=/',
      ])
      expect(response.status).toBe(source === 'error' ? 409 : 201)
      expect(response.headers.get('X-Result')).toBe('created')
      if (source === 'error') expect((await response.json()).error.message).toBe('Conflict')
      else expect(await response.text()).toBe('created')
    } finally {
      await app.close()
    }
  },
)
