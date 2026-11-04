import { HTTPException } from 'hono/http-exception'
import { describe, expect, it } from 'vitest'

import { formatResponse } from '../../src/app/http/output'
import { createClient } from '../../src/entries/client'
import { createApp, defineApp, route, setCookie } from '../../src/entries/root'
import { createDefinition } from '../../src/entries/runtime/core'
import { HttpError } from '../../src/http/error'
import { parseApiFilePath } from '../../src/http/path'
import { routeEntry as entry, executeRequest } from '../helpers/http-app'

it('preserves middleware headers and cookies when the handler returns an immutable redirect', async () => {
  const app = await createApp(
    createDefinition({
      app: defineApp({
        middleware: [
          async (ctx, next) => {
            setCookie(ctx, 'first', 'one')
            await next()
            setCookie(ctx, 'second', 'two')
            ctx.header('X-Middleware', 'applied')
          },
        ],
      }),
      routes: [
        {
          routePath: parseApiFilePath('auth.get.ts', '/api')!,
          declaration: route().handler(() => Response.redirect('https://example.com/login', 302)),
        },
      ],
    }),
  )
  try {
    const response = await app.fetch(new Request('http://localhost/api/auth'))
    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toBe('https://example.com/login')
    expect(response.headers.get('X-Middleware')).toBe('applied')
    expect(response.headers.getSetCookie()).toEqual(
      expect.arrayContaining([
        expect.stringContaining('first=one'),
        expect.stringContaining('second=two'),
      ]),
    )
    expect(response.headers.getSetCookie()).toHaveLength(2)
  } finally {
    await app.close()
  }
})

it('uses UTF-8 byte length for JSON and preserves representation headers on HEAD', async () => {
  const payload = { message: '中文 🐈', num: 42 }
  const expected = JSON.stringify(payload)
  for (const method of ['GET', 'HEAD']) {
    const response = formatResponse(payload, new Request('http://localhost/api/test', { method }))
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Length')).toBe(String(Buffer.byteLength(expected)))
    expect(response.headers.get('Content-Type')).toBe('application/json; charset=utf-8')
    expect(await response.text()).toBe(method === 'HEAD' ? '' : expected)
  }
})

it.each([false, true])(
  'retains pending headers and cookies on a native HTTP error (response cookies: %s)',
  async (responseHasCookie) => {
    const app = await createApp(
      createDefinition({
        routes: [
          {
            routePath: parseApiFilePath('failure.get.ts', '/api')!,
            declaration: route().handler((ctx) => {
              ctx.header('X-Handler', 'pending')
              setCookie(ctx, 'pending', 'one')
              throw new HTTPException(403, {
                res: new Response('forbidden', {
                  status: 403,
                  headers: responseHasCookie ? { 'Set-Cookie': 'error=two; Path=/' } : {},
                }),
              })
            }),
          },
        ],
      }),
    )
    try {
      const response = await app.fetch(new Request('http://localhost/api/failure'))
      expect(response.status).toBe(403)
      expect(await response.text()).toBe('forbidden')
      expect(response.headers.get('X-Handler')).toBe('pending')
      const cookies = response.headers.getSetCookie()
      expect(cookies).toContainEqual(expect.stringContaining('pending=one'))
      expect(cookies).toHaveLength(responseHasCookie ? 2 : 1)
      if (responseHasCookie) expect(cookies).toContainEqual(expect.stringContaining('error=two'))
    } finally {
      await app.close()
    }
  },
)

it.each([204, 205, 304])('serializes HTTP %s without a forbidden response body', async (status) => {
  const response = new HttpError(status, 'No representation', {
    headers: { ETag: '"version"' },
  }).toResponse()
  expect(response.status).toBe(status)
  expect(response.headers.get('etag')).toBe('"version"')
  expect(response.body).toBeNull()
  expect(await response.text()).toBe('')
})

describe('response policy', () => {
  it('HttpError preserves the application status', async () => {
    const res = await executeRequest(
      {},
      entry('/api/fail', () => {
        throw new HttpError(403, 'Denied')
      }),
      new Request('http://localhost/api/fail'),
    )
    expect(res.status).toBe(403)
  })

  it('header overrides are case insensitive', async () => {
    const res = await executeRequest(
      { headers: { 'x-frame-options': 'DENY' } },
      entry('/api/ping', () => ({ ok: true })),
      new Request('http://localhost/api/ping'),
    )
    expect(res.headers.get('x-frame-options')).toBe('DENY')
  })

  it('redirects retain common response headers', async () => {
    const e = entry('/api/ping', () => ({ ok: true }))
    const res = await executeRequest({}, e, new Request('http://localhost/api/ping/'))
    expect(res.status).toBe(308)
    expect(res.headers.get('X-Request-Id')).toBeTruthy()
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
  })

  it('JSON Accept Vary does not mistake Accept-Encoding for Accept', async () => {
    const e = entry(
      'vary.get.ts',
      route({
        middleware: [
          async (ctx: any, next: any) => {
            ctx.header('Vary', 'Accept-Encoding')
            await next()
          },
        ],
      }).handler(() => ({ ok: true })),
    )
    const app = await createApp(createDefinition({ app: defineApp({ csrf: false }), routes: [e] }))
    try {
      const res = await app.fetch(new Request('http://localhost/api/vary'))
      expect(
        res.headers
          .get('Vary')!
          .split(',')
          .map((value) => value.trim()),
      ).toContain('Accept')
    } finally {
      await app.close()
    }
  })

  it('headers false remains disabled through application creation', async () => {
    const app = await createApp(
      createDefinition({
        app: defineApp({ headers: false }),
        routes: [
          entry(
            'ping.get.ts',
            route().handler(() => 'ok'),
          ),
        ],
      }),
    )
    try {
      const response = await app.fetch(new Request('http://localhost/api/ping'))
      expect(response.headers.get('X-Content-Type-Options')).toBeNull()
      expect(response.headers.get('X-Frame-Options')).toBeNull()
    } finally {
      await app.close()
    }
  })

  it('406 Not Acceptable preserves existing Vary header and appends Accept', async () => {
    const e = entry(
      'notacceptable.get.ts',
      route({
        middleware: [
          async (ctx: any, next: any) => {
            ctx.header('Vary', 'Accept-Encoding')
            await next()
          },
        ],
      }).handler(() => ({ ok: true })),
    )
    const app = await createApp(createDefinition({ app: defineApp({ csrf: false }), routes: [e] }))
    try {
      const res = await app.fetch(
        new Request('http://localhost/api/notacceptable', {
          headers: { Accept: 'text/html' },
        }),
      )
      expect(res.status).toBe(406)
      const varyTokens = res.headers
        .get('Vary')!
        .split(',')
        .map((t) => t.trim())
      expect(varyTokens).toContain('Accept-Encoding')
      expect(varyTokens).toContain('Accept')
    } finally {
      await app.close()
    }
  })
})

it('uses upstream Accept quality selection and keeps automatic JSON distinct from explicit responses', async () => {
  const app = await createApp(
    createDefinition({
      routes: [
        {
          routePath: parseApiFilePath('json.get.ts', '/api')!,
          declaration: route({
            middleware: [
              async (ctx, next) => {
                ctx.header('Content-Type', 'text/plain')
                await next()
              },
            ],
          }).handler(() => ({ ok: true })),
        },
        {
          routePath: parseApiFilePath('text.get.ts', '/api')!,
          declaration: route().handler((ctx) => ctx.text('hello')),
        },
      ],
    }),
  )
  try {
    const client = createClient({ baseUrl: 'https://example.test/api', fetch: app.fetch })
    expect(
      await client.get('/json', {
        headers: { Accept: 'application/json;q=0, application/json;q=0.8' },
      }),
    ).toEqual({ ok: true })
    expect(await client.get('/text', { headers: { Accept: 'text/plain' } })).toBe('hello')
    const rejected = await app.fetch(
      new Request('https://example.test/api/json', {
        headers: { Accept: 'application/json;q=0, */*;q=1' },
      }),
    )
    expect(rejected.status).toBe(406)
  } finally {
    await app.close()
  }
})

it('preserves native Hono protocol errors without converting them to internal server failures', async () => {
  const instance = await createApp(
    createDefinition({
      routes: [
        {
          routePath: parseApiFilePath('private.get.ts', '/api')!,
          declaration: route().handler(() => {
            throw new HTTPException(401, {
              res: new Response('Sign in', {
                status: 401,
                headers: { 'WWW-Authenticate': 'Bearer', 'X-Auth': 'required' },
              }),
            })
          }),
        },
      ],
    }),
  )
  try {
    const response = await instance.fetch(new Request('https://site.example/api/private'))
    expect(response.status).toBe(401)
    expect(response.headers.get('WWW-Authenticate')).toBe('Bearer')
    expect(response.headers.get('X-Auth')).toBe('required')
    expect(await response.text()).toBe('Sign in')
  } finally {
    await instance.close()
  }
})
