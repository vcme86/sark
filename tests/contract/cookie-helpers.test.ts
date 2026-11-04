import { describe, expect, it } from 'vitest'

import { createApp, defineApp, setCookie } from '../../src/entries/root'
import { createDefinition } from '../../src/entries/runtime/core'
import { routeEntry as entry, executeRequest } from '../helpers/http-app'

describe('cookie helpers', () => {
  it('configured cookie defaults are used', async () => {
    const res = await executeRequest(
      { cookie: { sameSite: 'strict', secure: true } },
      entry('/api/cookie', (ctx: any) => {
        setCookie(ctx, 'theme', 'dark')
        return { ok: true }
      }),
      new Request('http://localhost/api/cookie'),
    )
    expect(res.headers.get('set-cookie')).toEqual(expect.stringContaining('SameSite=Strict'))
    expect(res.headers.get('set-cookie')).toContain('Secure')
  })

  it('cookie helpers use resolved factory configuration', async () => {
    const e = entry('/api/cookie', (ctx: any) => {
      setCookie(ctx, 'theme', 'dark')
      return { ok: true }
    })
    const app = await createApp(
      createDefinition({
        app: defineApp((env: any) => ({ cookie: { sameSite: env.sameSite, secure: true } })),
        routes: [e],
      }),
      { env: { sameSite: 'strict' } },
    )
    try {
      const res = await app.fetch(new Request('http://localhost/api/cookie'))
      expect(res.headers.get('Set-Cookie')).toEqual(expect.stringContaining('SameSite=Strict'))
    } finally {
      await app.close()
    }
  })
})
