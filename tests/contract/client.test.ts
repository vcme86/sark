import { describe, expect, it, vi } from 'vitest'

import { createClient, HttpError } from '../../src/entries/http'
import { createDefinition } from '../../src/entries/runtime/core'
import { createApp, defineApp, route, z } from '../../src/entries/server'
import { parseApiFilePath } from '../../src/http/path'

it('always appends relative endpoints, including paths that begin with the base pathname', async () => {
  const fetch = vi.fn(async (_request: Request) => new Response(null, { status: 204 }))
  const client = createClient({ baseUrl: 'https://example.test/api', fetch })
  await client.get('/api/items')
  expect(fetch.mock.calls[0][0].url).toBe('https://example.test/api/api/items')
})

describe('client media encoding and decoding', () => {
  it('rejects Content-Type conflicting with the chosen encoding before fetching', async () => {
    const fetch = vi.fn(async (_request: Request) => new Response(null, { status: 204 }))
    const client = createClient({ baseUrl: 'https://example.test/api', fetch })
    await expect(
      client.post('/data', { json: {}, headers: { 'Content-Type': 'text/plain' } }),
    ).rejects.toThrow(TypeError)
    await expect(
      client.post('/data', { text: 'hello', headers: { 'Content-Type': 'application/json' } }),
    ).rejects.toThrow(TypeError)
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([200, 502])('preserves JSON decoding failure for status %s', async (status) => {
    const client = createClient({
      baseUrl: 'https://example.test/api',
      fetch: async () =>
        new Response('<html>bad gateway</html>', {
          status,
          headers: { 'Content-Type': 'application/json' },
        }),
    })
    await expect(client.get('/data')).rejects.toBeInstanceOf(SyntaxError)
  })

  it.each([
    { name: 'URLSearchParams', form: () => new URLSearchParams({ name: 'Alice' }) },
    { name: 'plain object', form: () => ({ name: 'Alice' }) },
  ])('rejects conflicting inherited Content-Type for $name forms', async ({ form }) => {
    const fetch = vi.fn(async (_request: Request) => new Response(null, { status: 204 }))
    const client = createClient({
      baseUrl: 'https://example.test/api',
      headers: { 'Content-Type': 'application/json' },
      fetch,
    })
    await expect(client.post('/form', { form: form() })).rejects.toThrow(TypeError)
    expect(fetch).not.toHaveBeenCalled()
    await client.post('/form', {
      form: form(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
    })
    const request = fetch.mock.calls[0][0]
    expect(request.headers.get('Content-Type')).toBe(
      'application/x-www-form-urlencoded; charset=utf-8',
    )
    expect(await request.text()).toBe('name=Alice')
  })

  it('encodes repeated form fields and lets fetch set multipart boundaries', async () => {
    const requests: Request[] = []
    const client = createClient({
      baseUrl: 'https://example.test/api',
      fetch: async (request) => {
        requests.push(request)
        return new Response(null, { status: 204 })
      },
    })
    await client.post('/form', { form: { name: ['Alice', 'Bob'] } })
    expect(requests[0].headers.get('Content-Type')).toBe(
      'application/x-www-form-urlencoded; charset=utf-8',
    )
    expect((await requests[0].formData()).getAll('name')).toEqual(['Alice', 'Bob'])
    const form = new FormData()
    form.append('name', 'Alice')
    await client.post('/form', { form, headers: { 'Content-Type': 'application/json' } })
    expect(requests[1].headers.get('Content-Type')).toMatch(/^multipart\/form-data; boundary=/)
    expect((await requests[1].formData()).get('name')).toBe('Alice')
  })

  it('inherits client credentials by default and allows per-call init override', async () => {
    let capturedReq: Request | undefined
    const client = createClient({
      baseUrl: 'https://example.test/api',
      credentials: 'include',
      fetch: async (req) => {
        capturedReq = req
        return new Response(null, { status: 204 })
      },
    })

    // 1. Inherits 'include' from client options
    await client.get('/test')
    expect(capturedReq?.credentials).toBe('include')

    // 2. Overrides via call init
    await client.get('/test', { init: { credentials: 'omit' } })
    expect(capturedReq?.credentials).toBe('omit')

    // 3. Fallback without client options defaults to 'same-origin'
    let defaultCaptured: Request | undefined
    const defaultClient = createClient({
      baseUrl: 'https://example.test/api',
      fetch: async (req) => {
        defaultCaptured = req
        return new Response(null, { status: 204 })
      },
    })
    await defaultClient.get('/test')
    expect(defaultCaptured?.credentials).toBe('same-origin')
  })

  it('verifies HttpError.body difference between server construction and client decoding', async () => {
    // On the server, HttpError is thrown with status, message, code, details; body is undefined
    const serverError = new HttpError(400, 'Invalid argument', {
      code: 'invalid_arg',
      details: { param: 'id' },
    })
    expect(serverError.status).toBe(400)
    expect(serverError.code).toBe('invalid_arg')
    expect(serverError.details).toEqual({ param: 'id' })
    expect(serverError.body).toBeUndefined()

    // On the client, a structured error response is decoded into HttpError.body
    const errorPayload = {
      error: { code: 'validation_failed', message: 'Field too short', details: { min: 5 } },
    }
    const clientJson = createClient({
      baseUrl: 'https://example.test/api',
      fetch: async () =>
        new Response(JSON.stringify(errorPayload), {
          status: 422,
          headers: { 'Content-Type': 'application/json' },
        }),
    })

    let caughtClientError: HttpError | undefined
    try {
      await clientJson.get('/validate')
    } catch (err) {
      if (err instanceof HttpError) caughtClientError = err
    }

    expect(caughtClientError).toBeDefined()
    expect(caughtClientError?.status).toBe(422)
    expect(caughtClientError?.code).toBe('validation_failed')
    expect(caughtClientError?.message).toBe('Field too short')
    expect(caughtClientError?.details).toEqual({ min: 5 })
    expect(caughtClientError?.body).toEqual(errorPayload)

    // On the client, a non-structured text/HTML response retains the raw string as body
    const clientText = createClient({
      baseUrl: 'https://example.test/api',
      fetch: async () =>
        new Response('502 Bad Gateway from upstream', {
          status: 502,
          headers: { 'Content-Type': 'text/plain' },
        }),
    })

    let caughtGatewayError: HttpError | undefined
    try {
      await clientText.get('/gateway')
    } catch (err) {
      if (err instanceof HttpError) caughtGatewayError = err
    }

    expect(caughtGatewayError).toBeDefined()
    expect(caughtGatewayError?.status).toBe(502)
    expect(caughtGatewayError?.code).toBe('http_error')
    expect(caughtGatewayError?.body).toBe('502 Bad Gateway from upstream')
  })
})

it('dispatches QUERY bodies and ALL fallbacks through the client and application', async () => {
  const app = await createApp(
    createDefinition({
      app: defineApp({ csrf: false }),
      routes: [
        {
          routePath: parseApiFilePath('lookup.query.ts', '/api')!,
          declaration: route()
            .validate({ json: z.object({ term: z.string() }) })
            .handler((_ctx, input) => ({ found: input.json.term })),
        },
        {
          routePath: parseApiFilePath('mixed.all.ts', '/api')!,
          declaration: route()
            .validate({ json: z.object({ value: z.number() }) })
            .handler((ctx, input) => ({ method: ctx.req.method, value: input.json.value })),
        },
        {
          routePath: parseApiFilePath('mixed.get.ts', '/api')!,
          declaration: route().handler(() => ({ specific: true })),
        },
      ],
    }),
  )
  const client = createClient({ baseUrl: 'https://example.test/api', fetch: app.fetch })
  try {
    expect(await client.query('/lookup', { json: { term: 'book' } })).toEqual({ found: 'book' })
    expect(await client.get('/mixed')).toEqual({ specific: true })
    expect(await client.post('/mixed', { json: { value: 42 } })).toEqual({
      method: 'POST',
      value: 42,
    })
    expect((await client.head('/mixed')).status).toBe(200)
  } finally {
    await app.close()
  }
})

describe('client encoding', () => {
  it('raw requests inherit client credentials and headers', async () => {
    let captured: Request | undefined
    const client = createClient({
      baseUrl: 'https://api.example/api',
      credentials: 'include',
      headers: { Authorization: 'Bearer demo' },
      fetch: async (req) => {
        captured = req
        return new Response(null, { status: 204 })
      },
    })
    await client.requestRaw('GET', '/ping')
    expect(captured?.credentials).toBe('include')
    expect(captured?.headers.get('Authorization')).toBe('Bearer demo')
  })

  it('array of upload files is encoded as multipart with repeated fields', async () => {
    let captured: Request | undefined
    const client = createClient({
      baseUrl: 'http://localhost/api',
      fetch: async (req) => {
        captured = req
        return new Response(null, { status: 204 })
      },
    })
    await client.post('/upload', {
      form: { files: [new File(['one'], 'one.txt'), new File(['two'], 'two.txt')] },
    })
    const data = await captured!.formData()
    const files = data.getAll('files') as File[]
    expect(files.map((file) => file.name)).toEqual(['one.txt', 'two.txt'])
    expect(await Promise.all(files.map((file) => file.text()))).toEqual(['one', 'two'])
  })

  it('multipart drops default Content-Type so Fetch can set its boundary', async () => {
    let captured: Request | undefined
    const client = createClient({
      baseUrl: 'http://localhost/api',
      headers: { 'Content-Type': 'application/json' },
      fetch: async (req) => {
        captured = req
        return new Response(null, { status: 204 })
      },
    })
    const form = new FormData()
    form.set('file', new File(['one'], 'one.txt'))
    await client.post('/upload', { form })
    expect(captured!.headers.get('Content-Type')).toMatch(/^multipart\/form-data; boundary=/)
  })

  it('non-JSON non-text HTTP error preserves decoded body', async () => {
    const client = createClient({
      baseUrl: 'http://localhost/api',
      fetch: async () =>
        new Response(new Uint8Array([1, 2]), {
          status: 502,
          headers: { 'Content-Type': 'application/octet-stream' },
        }),
    })
    let error: any
    try {
      await client.get('/download')
    } catch (e) {
      error = e
    }
    expect(error.status).toBe(502)
    expect(error.body).toBeInstanceOf(ArrayBuffer)
    expect([...new Uint8Array(error.body)]).toEqual([1, 2])
  })
})
