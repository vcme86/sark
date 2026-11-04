import { describe, expect, it } from 'vitest'

import { createApp, defineApp, route } from '../../src/entries/root'
import { createDefinition } from '../../src/entries/runtime/core'
import { routeEntry as entry, executeRequest } from '../helpers/http-app'

describe('request policy', () => {
  it('application CORS policy is applied', async () => {
    const res = await executeRequest(
      { cors: { origin: 'https://frontend.example' } },
      entry('/api/ping', () => ({ ok: true })),
      new Request('http://localhost/api/ping', { headers: { Origin: 'https://frontend.example' } }),
    )
    expect(res.headers.get('access-control-allow-origin')).toBe('https://frontend.example')
  })

  it('application middleware enforces the configured authorization', async () => {
    let ran = false
    const res = await executeRequest(
      {
        middleware: [
          (ctx: any) => {
            ran = true
            return ctx.text('Denied', 403)
          },
        ],
      },
      entry('/api/private', () => ({ secret: 'example' })),
      new Request('http://localhost/api/private'),
    )
    expect(ran).toBe(true)
    expect(res.status).toBe(403)
  })

  it('default CSRF protection rejects a cross-origin text POST', async () => {
    const e = entry('/api/write', () => ({ ok: true }), 'post')
    const res = await executeRequest(
      {},
      e,
      new Request('http://localhost/api/write', {
        method: 'POST',
        headers: { Origin: 'https://other.example', 'Content-Type': 'text/plain' },
        body: 'update',
      }),
    )
    expect(res.status).toBe(403)
  })

  it('CORS preflight reaches the configured endpoint policy', async () => {
    const e = entry('/api/ping', () => ({ ok: true }))
    const res = await executeRequest(
      { cors: { origin: 'https://frontend.example' } },
      e,
      new Request('http://localhost/api/ping', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://frontend.example',
          'Access-Control-Request-Method': 'GET',
        },
      }),
    )
    expect(res.status).toBe(204)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://frontend.example')
  })

  it('additional CSRF origins retain the current origin', async () => {
    const e = entry('/api/write', () => ({ ok: true }), 'post')
    const res = await executeRequest(
      { csrf: { origins: ['https://frontend.example'] } },
      e,
      new Request('http://localhost/api/write', {
        method: 'POST',
        headers: { Origin: 'http://localhost', 'Content-Type': 'text/plain' },
        body: 'update',
      }),
    )
    expect(res.status).toBe(200)
  })

  it('preflight selects policy by requested method as well as path', async () => {
    const routes = [
      entry(
        'item.get.ts',
        route({ cors: { origin: 'https://reader.example' } }).handler(() => 'read'),
      ),
      entry(
        'item.post.ts',
        route({ cors: { origin: 'https://writer.example' } }).handler(() => 'write'),
        'post',
      ),
    ]
    const app = await createApp(createDefinition({ app: defineApp({ csrf: false }), routes }))
    try {
      const res = await app.fetch(
        new Request('http://localhost/api/item', {
          method: 'OPTIONS',
          headers: {
            Origin: 'https://reader.example',
            'Access-Control-Request-Method': 'GET',
          },
        }),
      )
      expect(res.status).toBe(204)
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://reader.example')
    } finally {
      await app.close()
    }
  })
})
