import { describe, expect, it } from 'vitest'

import { createClient } from '../../src/entries/client'
import { createApp, defineApp, route, z } from '../../src/entries/root'
import { createDefinition } from '../../src/entries/runtime/core'
import { parseApiFilePath } from '../../src/http/path'
import { routeEntry as entry, executeRequest } from '../helpers/http-app'

it('keeps each validated declaration independent when a route builder is reused', async () => {
  const base = route()
  const json = base.validate({ json: z.object({ value: z.number() }) })
  const text = base.validate({ text: z.string().transform(Number) })
  const app = await createApp(
    createDefinition({
      routes: [
        {
          routePath: parseApiFilePath('json.post.ts', '/api')!,
          declaration: json.handler((_ctx, input) => input.json.value),
        },
        {
          routePath: parseApiFilePath('text.post.ts', '/api')!,
          declaration: text.handler((_ctx, input) => input.text),
        },
      ],
    }),
  )
  try {
    const client = createClient({
      baseUrl: 'https://example.test/api',
      fetch: app.fetch,
      headers: { Origin: 'https://example.test' },
    })
    expect(await client.post('/json', { json: { value: 42 } })).toBe(42)
    expect(await client.post('/text', { text: '7' })).toBe(7)
  } finally {
    await app.close()
  }
})

it.each([
  { kind: 'json', contentType: 'text/plain; note="application/json"', body: '{}' },
  { kind: 'form', contentType: 'text/plain; note="multipart/form-data"', body: 'name=Alice' },
] as const)(
  'checks the actual $kind media type rather than matching parameter substrings',
  async ({ kind, contentType, body }) => {
    const schemas =
      kind === 'json' ? { json: z.object({}) } : { form: z.object({ name: z.string() }) }
    const app = await createApp(
      createDefinition({
        routes: [
          {
            routePath: parseApiFilePath('input.post.ts', '/api')!,
            declaration: route()
              .validate(schemas)
              .handler(() => ({ ok: true })),
          },
        ],
      }),
    )
    try {
      const response = await app.fetch(
        new Request('https://example.test/api/input', {
          method: 'POST',
          headers: { 'Content-Type': contentType, Origin: 'https://example.test' },
          body,
        }),
      )
      expect(response.status).toBe(415)
    } finally {
      await app.close()
    }
  },
)

it.each(['query', 'form'] as const)('collects repeated %s field names as data', async (kind) => {
  const schema = z.object({ constructor: z.array(z.string()) })
  const app = await createApp(
    createDefinition({
      routes: [
        {
          routePath: parseApiFilePath(`fields.${kind === 'query' ? 'get' : 'post'}.ts`, '/api')!,
          declaration:
            kind === 'query'
              ? route()
                  .validate({ query: schema })
                  .handler((_ctx, input) => input.query.constructor)
              : route()
                  .validate({ form: schema })
                  .handler((_ctx, input) => input.form.constructor),
        },
      ],
    }),
  )
  try {
    const client = createClient({
      baseUrl: 'https://example.test/api',
      fetch: app.fetch,
      headers: { Origin: 'https://example.test' },
    })
    const result =
      kind === 'query'
        ? await client.get('/fields', { query: { constructor: ['one', 'two'] } })
        : await client.post('/fields', { form: { constructor: ['one', 'two'] } })
    expect(result).toEqual(['one', 'two'])
  } finally {
    await app.close()
  }
})

describe('request input', () => {
  it('body limit counts bytes', async () => {
    const decl = route()
      .validate({ json: z.string() })
      .handler((_ctx, input) => input.json)

    const e = entry('/api/data', decl, 'post')

    const res = await executeRequest(
      { bodyLimit: 4, csrf: false },
      e,
      new Request('http://localhost/api/data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify('你'),
      }),
    )
    expect(res.status).toBe(413)
  })
})

it('rejects oversized declared lengths early and limits unknown-length bodies as read', async () => {
  let calls = 0
  const instance = await createApp(
    createDefinition({
      app: defineApp({ csrf: false, bodyLimit: 4 }),
      routes: [
        {
          routePath: parseApiFilePath('echo.post.ts', '/api')!,
          declaration: route({
            middleware: [
              async (_ctx, next) => {
                calls++
                await next()
              },
            ],
          }).handler(async (ctx) => ctx.req.text()),
        },
      ],
    }),
  )
  try {
    for (const contentType of [
      'application/json',
      'text/plain',
      'application/x-www-form-urlencoded',
    ]) {
      for (const body of ['1234', '12345']) {
        const response = await instance.fetch(
          new Request('https://site.example/api/echo', {
            method: 'POST',
            body,
            headers: { 'Content-Type': contentType, 'Content-Length': String(body.length) },
          }),
        )
        expect(response.status).toBe(body.length <= 4 ? 200 : 413)
        await response.text()
      }
    }
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(5))
      },
      cancel() {
        cancelled = true
      },
    })
    const response = await instance.fetch(
      new Request('https://site.example/api/echo', {
        method: 'POST',
        body,
        duplex: 'half',
      } as RequestInit),
    )
    expect(response.status).toBe(413)
    await response.text()
    expect(cancelled).toBe(true)
    expect(calls).toBe(4)
  } finally {
    await instance.close()
  }
})

it('rejects unsupported schemas at declaration time and reuses the prepared schema interface', async () => {
  // @ts-expect-error A factory is not a schema, including when called from JavaScript.
  expect(() => route().validate({ json: z.string })).toThrow(/Route schema/)
  let selections = 0
  const schema = {
    get '~standard'() {
      selections++
      return { version: 1 as const, vendor: 'sark-test', validate: (value: unknown) => ({ value }) }
    },
  }
  const instance = await createApp(
    createDefinition({
      app: defineApp({ csrf: false }),
      routes: [
        {
          routePath: parseApiFilePath('echo.post.ts', '/api')!,
          declaration: route()
            .validate({ text: schema })
            .handler((_ctx, input) => input.text),
        },
      ],
    }),
  )
  try {
    for (const text of ['first', 'second']) {
      const response = await instance.fetch(
        new Request('https://site.example/api/echo', { method: 'POST', body: text }),
      )
      expect(await response.json()).toBe(text)
    }
    expect(selections).toBe(1)
  } finally {
    await instance.close()
  }
})
