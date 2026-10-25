import { configureSync, getConfig, resetSync } from '@logtape/logtape'
import { expect, it, vi } from 'vitest'

import { createClient } from '../../src/entries/http'
import { createDefinition } from '../../src/entries/runtime/core'
import { createApp, getLogger, route, z } from '../../src/entries/server'
import { parseApiFilePath } from '../../src/web/http/path'

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

it('restores basic diagnostics after the host resets LogTape, including custom application categories', async () => {
  const previous = getConfig()
  const output = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    for (const generation of [1, 2]) {
      resetSync()
      const app = await createApp(createDefinition())
      try {
        getLogger('queries').error(`diagnostic-generation-${generation}`)
        expect(output.mock.calls.flat().join(' ')).toContain(`diagnostic-generation-${generation}`)
      } finally {
        await app.close()
      }
    }
  } finally {
    output.mockRestore()
    if (previous) configureSync({ ...previous, reset: true })
    else resetSync()
  }
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
