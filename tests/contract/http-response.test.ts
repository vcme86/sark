import { HTTPException } from 'hono/http-exception'
import { expect, it } from 'vitest'

import { createDefinition } from '../../src/entries/runtime/core'
import { createApp, defineApp, route, setCookie } from '../../src/entries/server'
import { parseApiFilePath } from '../../src/web/http/path'
import { formatResponse } from '../../src/web/http/server/output'

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
