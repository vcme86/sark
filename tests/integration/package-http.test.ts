import { createApp, defineApp, route, z } from '@olivaw/sark'
import { compress } from '@olivaw/sark/middleware'
import { defineNodeRuntime } from '@olivaw/sark/node'
import { createDefinition } from '@olivaw/sark/runtime/core'
import { startNodeServer } from '@olivaw/sark/runtime/node'
import { describe, expect, it } from 'vitest'

import { parseApiFilePath } from '../../src/http/path'

describe('Compression through built package entries and Node delivery', () => {
  it.each([false, { threshold: 0 }] as const)(
    'preserves explicit compression policy %j for streamed request bodies',
    async (policy) => {
      const instance = await createApp(
        createDefinition({
          app: defineApp({ csrf: false }),
          routes: [
            {
              routePath: parseApiFilePath('upload.post.ts', '/api')!,
              declaration: route({ middleware: [compress(policy)] })
                .validate({ text: z.string() })
                .handler((_ctx, input) => ({ content: input.text, padding: 'a'.repeat(5000) })),
            },
          ],
        }),
      )
      const control = await startNodeServer(
        instance,
        defineNodeRuntime({ compress: policy === false }),
        { PORT: '0' },
      )
      try {
        const response = await fetch(`http://127.0.0.1:${control.port}/api/upload`, {
          method: 'POST',
          headers: { 'Accept-Encoding': 'gzip', 'Content-Type': 'text/plain' },
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('streamed upload'))
              controller.close()
            },
          }),
          duplex: 'half',
        } as RequestInit)
        expect(response.status).toBe(200)
        expect(response.headers.get('Content-Encoding')).toBe(policy === false ? null : 'gzip')
        expect(await response.json()).toEqual({
          content: 'streamed upload',
          padding: 'a'.repeat(5000),
        })
      } finally {
        await control.close()
      }
    },
  )

  it('preserves contentTypeFilter function and RegExp in-memory without HTTP header serialization', async () => {
    let filterCalls = 0
    const filterFn = (_type: string) => {
      filterCalls++
      return false // Explicitly reject compression
    }

    const appInstance = await createApp(
      createDefinition({
        app: defineApp({}),
        routes: [
          {
            routePath: parseApiFilePath('filtered.get.ts', '/api')!,
            declaration: route({
              middleware: [compress({ threshold: 0, contentTypeFilter: filterFn })],
            }).handler(() => ({ data: 'A'.repeat(5000) })),
          },
          {
            routePath: parseApiFilePath('regex-compressed.get.ts', '/api')!,
            declaration: route({
              middleware: [compress({ threshold: 0, contentTypeFilter: /^application\/json/ })],
            }).handler(() => ({ data: 'B'.repeat(5000) })),
          },
        ],
      }),
    )

    // Direct instance.fetch should not leak x-sark-compress header
    const rawReq = new Request('http://localhost/api/filtered')
    const directRes = await appInstance.fetch(rawReq)
    expect(directRes.headers.get('x-sark-compress')).toBeNull()

    // Run Node delivery layer listener
    const serverControl = await startNodeServer(appInstance, undefined, { PORT: '0' })
    try {
      // Test 1: filtered endpoint should not be compressed
      const resFiltered = await fetch(`http://127.0.0.1:${serverControl.port}/api/filtered`, {
        headers: { 'Accept-Encoding': 'gzip' },
      })
      expect(resFiltered.status).toBe(200)
      expect(resFiltered.headers.get('Content-Encoding')).toBeNull()
      expect(resFiltered.headers.get('x-sark-compress')).toBeNull()
      expect(filterCalls).toBeGreaterThan(0)
      expect(await resFiltered.json()).toEqual({ data: 'A'.repeat(5000) })

      // Test 2: regex endpoint should be compressed with gzip
      const resRegex = await fetch(`http://127.0.0.1:${serverControl.port}/api/regex-compressed`, {
        headers: { 'Accept-Encoding': 'gzip' },
      })
      expect(resRegex.status).toBe(200)
      expect(resRegex.headers.get('Content-Encoding')).toBe('gzip')
      expect(resRegex.headers.get('x-sark-compress')).toBeNull()
      expect(await resRegex.json()).toEqual({ data: 'B'.repeat(5000) })
    } finally {
      await serverControl.close()
    }
  })

  it('allows explicit compress() to override runtime threshold with common defaults', async () => {
    const appInstance = await createApp(
      createDefinition({
        app: defineApp({}),
        routes: [
          {
            routePath: parseApiFilePath('small-override.get.ts', '/api')!,
            declaration: route({
              middleware: [compress()],
            }).handler(() => ({ data: 'A'.repeat(2000) })),
          },
          {
            routePath: parseApiFilePath('small-uncompressed.get.ts', '/api')!,
            declaration: route().handler(() => ({ data: 'A'.repeat(2000) })),
          },
        ],
      }),
    )

    const serverControl = await startNodeServer(
      appInstance,
      defineNodeRuntime({
        compress: { threshold: 99999 },
      }),
      { PORT: '0' },
    )

    try {
      // 1. Without route compress(), 2KB payload does not meet runtime's 99999 threshold -> uncompressed
      const resUncomp = await fetch(
        `http://127.0.0.1:${serverControl.port}/api/small-uncompressed`,
        {
          headers: { 'Accept-Encoding': 'gzip' },
        },
      )
      expect(resUncomp.status).toBe(200)
      expect(resUncomp.headers.get('Content-Encoding')).toBeNull()

      // 2. With route compress(), route policy overrides runtime with common defaults -> compressed
      const resComp = await fetch(`http://127.0.0.1:${serverControl.port}/api/small-override`, {
        headers: { 'Accept-Encoding': 'gzip' },
      })
      expect(resComp.status).toBe(200)
      expect(resComp.headers.get('Content-Encoding')).toBe('gzip')
    } finally {
      await serverControl.close()
    }
  })
})
