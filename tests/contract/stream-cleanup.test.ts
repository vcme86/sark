import { configureSync, getConfig, type LogRecord, resetSync } from '@logtape/logtape'
import { createElement, Suspense } from 'react'
import { afterEach, beforeEach, expect, it, type MockInstance, vi } from 'vitest'

import { createDefinition } from '../../src/app/definition'
import { createClient } from '../../src/client/client'
import { createApp, route } from '../../src/entries/root'
import { parseApiFilePath } from '../../src/http/path'
import { renderPageToResponse, type ServerRenderOptions } from '../../src/page/server/render'
import { RedirectSignal } from '../../src/page/signals'

const observed = vi.hoisted(() => ({
  stream: undefined as ReadableStream | undefined,
  originalCancel: undefined as ReadableStream['cancel'] | undefined,
  cancel: undefined as MockInstance<ReadableStream['cancel']> | undefined,
}))

vi.mock('react-dom/server', async (load) => {
  const original = await load<typeof import('react-dom/server')>()
  return {
    ...original,
    async renderToReadableStream(...args: Parameters<typeof original.renderToReadableStream>) {
      const stream = await original.renderToReadableStream(...args)
      observed.stream = stream
      observed.originalCancel = stream.cancel.bind(stream)
      observed.cancel = vi.spyOn(stream, 'cancel')
      return stream
    },
  }
})

let previous: ReturnType<typeof getConfig>
let records: LogRecord[]

beforeEach(() => {
  previous = getConfig()
  records = []
  observed.stream = undefined
  observed.originalCancel = undefined
  observed.cancel = undefined
  configureSync({
    reset: true,
    sinks: { capture: (record) => records.push(record) },
    loggers: [
      { category: ['app'], lowestLevel: 'warning', sinks: ['capture'] },
      { category: ['logtape', 'meta'], lowestLevel: 'error', sinks: [] },
    ],
  })
})

afterEach(async () => {
  try {
    if (observed.stream && !observed.cancel?.mock.calls.length && !observed.stream.locked) {
      await observed.stream.cancel()
    }
  } finally {
    vi.restoreAllMocks()
    if (previous) configureSync({ ...previous, reset: true })
    else resetSync()
  }
})

function renderOptions(overrides: Partial<ServerRenderOptions> = {}): ServerRenderOptions {
  const pending = new Promise<void>(() => {})
  const Deferred = () => {
    throw pending
  }
  return {
    url: new URL('https://example.test/'),
    params: {},
    scopes: [],
    signal: new AbortController().signal,
    client: createClient<unknown>(),
    identity: { user: null },
    bootstrapModules: [],
    stylesheets: [],
    production: false,
    build: { api: { browserUrl: '/api', credentials: 'same-origin' }, styles: {} },
    policy: { caseSensitive: false, trailingSlash: 'never' },
    rootComponent: () =>
      createElement(
        Suspense,
        { fallback: createElement('p', null, 'Loading') },
        createElement(Deferred),
      ),
    headers: () => new Headers(),
    onCommitHeaders() {},
    ...overrides,
  }
}

it('awaits HEAD body cleanup before delivering the original status and headers', async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const cancel = vi.fn(async () => {
    entered.resolve()
    await release.promise
  })
  const app = await createApp(
    createDefinition({
      routes: [
        {
          routePath: parseApiFilePath('stream.get.ts', '/api')!,
          declaration: route().handler(
            () =>
              new Response(new ReadableStream({ cancel }), {
                status: 201,
                headers: { 'Content-Type': 'text/plain', 'X-Representation': 'original' },
              }),
          ),
        },
      ],
    }),
  )
  try {
    let delivered = false
    const pending = app
      .fetch(new Request('https://example.test/api/stream', { method: 'HEAD' }))
      .then((response) => {
        delivered = true
        return response
      })
    await entered.promise
    expect(delivered).toBe(false)
    release.resolve()
    const response = await pending
    expect(response.status).toBe(201)
    expect(response.headers.get('x-representation')).toBe('original')
    expect(response.body).toBeNull()
    expect(cancel).toHaveBeenCalledOnce()
    expect(records).toEqual([])
  } finally {
    release.resolve()
    await app.close()
  }
})

it('reports HEAD cleanup failure once without replacing the response', async () => {
  const failure = new Error('Source cleanup failed')
  const app = await createApp(
    createDefinition({
      routes: [
        {
          routePath: parseApiFilePath('stream.get.ts', '/api')!,
          declaration: route().handler(
            () =>
              new Response(
                new ReadableStream({
                  cancel() {
                    throw failure
                  },
                }),
                {
                  status: 202,
                  headers: { 'X-Representation': 'original' },
                },
              ),
          ),
        },
      ],
    }),
  )
  try {
    const response = await app.fetch(
      new Request('https://example.test/api/stream', { method: 'HEAD' }),
    )
    expect(response.status).toBe(202)
    expect(response.headers.get('x-representation')).toBe('original')
    expect(response.body).toBeNull()
    expect(records).toHaveLength(1)
    expect(records[0].properties.error).toBe(failure)
    expect(records[0].properties.requestId).toBe(response.headers.get('x-request-id'))
  } finally {
    await app.close()
  }
})

it.each(['commit', 'headers'] as const)(
  'cancels the real React stream when %s preparation fails',
  async (stage) => {
    const failure = new Error(`Failed during ${stage}`)
    const options = renderOptions({
      [stage === 'commit' ? 'onCommitHeaders' : 'headers']: () => {
        throw failure
      },
    })
    const response = await renderPageToResponse(options)
    expect(response.status).toBe(500)
    expect(await response.text()).toContain(failure.message)
    expect(observed.cancel).toHaveBeenCalledOnce()
    expect(records).toHaveLength(1)
    expect(records[0].properties.error).toBe(failure)
  },
)

it('preserves the preparation error if cancellation also fails', async () => {
  const failure = new Error('Header preparation failed')
  const cleanup = new Error('Stream cleanup failed')
  const response = await renderPageToResponse(
    renderOptions({
      onCommitHeaders() {
        observed.cancel!.mockImplementationOnce(async () => {
          await observed.originalCancel!()
          throw cleanup
        })
        throw failure
      },
    }),
  )
  expect(response.status).toBe(500)
  expect(await response.text()).toContain(failure.message)
  expect(observed.cancel).toHaveBeenCalledOnce()
  expect(records.map((record) => record.properties.error)).toEqual([cleanup, failure])
})

it('cancels suspended HEAD rendering once without logging an intentional abort', async () => {
  const response = await renderPageToResponse(renderOptions({ head: true }))
  expect(response.status).toBe(200)
  expect(response.body).toBeNull()
  expect(observed.cancel).toHaveBeenCalledOnce()
  expect(records).toEqual([])
})

it('cancels a shell redirect once without committing headers or logging an intentional abort', async () => {
  const onCommitHeaders = vi.fn()
  const response = await renderPageToResponse(
    renderOptions({
      onCommitHeaders,
      rootComponent: () =>
        createElement(
          Suspense,
          { fallback: 'Redirecting' },
          createElement(() => {
            throw new RedirectSignal('/next', 302)
          }),
        ),
    }),
  )
  expect(response.status).toBe(302)
  expect(response.headers.get('location')).toBe('/next')
  expect(onCommitHeaders).not.toHaveBeenCalled()
  expect(observed.cancel).toHaveBeenCalledOnce()
  expect(records).toEqual([])
})

it('hands successful rendering to the response without cancelling its stream', async () => {
  const response = await renderPageToResponse(
    renderOptions({ rootComponent: () => createElement('p', null, 'Ready') }),
  )
  expect(response.status).toBe(200)
  expect(response.body).toBe(observed.stream)
  expect(await response.text()).toContain('Ready')
  expect(observed.cancel).not.toHaveBeenCalled()
  expect(records).toEqual([])
})
