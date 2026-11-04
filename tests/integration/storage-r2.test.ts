import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { preview, type PreviewServer } from 'vite'
import { describe, expect, it } from 'vitest'

import { createProject, runProjectCli, serverUrl, viteEntry } from '../helpers/project'

describe('Cloudflare R2 Object Storage Integration via Real Workerd', () => {
  it('executes put, head, get, delete, native binding check and atomic conditional non-overwrite against real workerd R2 binding', async () => {
    const project = createProject()

    project.write(
      'app.ts',
      `import { defineApp } from '@olivaw/sark'
import { defineStorage } from '@olivaw/sark/storage/r2'
import type { R2Bucket } from '@cloudflare/workers-types'

export const app = defineApp({ csrf: false })
export const storage = {
  media: defineStorage((env: { MEDIA_BUCKET: R2Bucket }) => ({
    binding: env.MEDIA_BUCKET,
    publicUrl: 'https://cdn.example.com',
  })),
}`,
    )

    project.write(
      'api/r2-test.post.ts',
      `import { route } from '@olivaw/sark'
import { StorageError } from '@olivaw/sark/storage/r2'

export default route().handler(async (c) => {
  try {
    const store = c.var.storage.media
    const nativeBucket = store.native
    const isSameNative = nativeBucket === c.env.MEDIA_BUCKET

    const key = 'documents/report.txt'
    const content = new TextEncoder().encode('Hello Cloudflare R2 native binding!')

    // 1. Initial head
    const initialHead = await store.head(key)

    // 2. Put object
    const stored = await store.put(key, content, { contentType: 'text/plain' })

    // 3. Head metadata
    const headAfterPut = await store.head(key)

    // 4. Get object body
    const retrieved = await store.get(key)
    let bodyText = ''
    if (retrieved) {
      bodyText = await new Response(retrieved.body).text()
    }

    // 4b. Test conditional get (ifNoneMatch -> not_modified, ifMatch -> precondition_failed)
    let notModifiedCode = ''
    let notModifiedMsg = ''
    try {
      await store.get(key, { ifNoneMatch: headAfterPut!.etag })
    } catch (err: any) {
      notModifiedCode = err?.code
      notModifiedMsg = err?.message
    }

    let preconditionFailedCode = ''
    let preconditionFailedMsg = ''
    try {
      await store.get(key, { ifMatch: '"wrong-etag-value"' })
    } catch (err: any) {
      preconditionFailedCode = err?.code
      preconditionFailedMsg = err?.message
    }

    // 5. Test default non-overwrite behavior (expect StorageError with code file_exists)
    let caughtOverwriteError: any = null
    try {
      await store.put(key, new TextEncoder().encode('Overwriting attempt!'))
    } catch (err: any) {
      if (err instanceof StorageError) {
        caughtOverwriteError = { code: err.code, message: err.message }
      } else {
        caughtOverwriteError = { code: 'unknown', message: err.message }
      }
    }

    // 6. Test explicit overwrite: true
    const overwritten = await store.put(key, new TextEncoder().encode('Updated text'), {
      overwrite: true,
      contentType: 'text/plain',
    })
    const headAfterOverwrite = await store.head(key)
    const retrievedOverwritten = await store.get(key)
    const overwrittenBodyText = retrievedOverwritten ? await new Response(retrievedOverwritten.body).text() : ''

    // 7. Delete object
    await store.delete(key)
    const headAfterDelete = await store.head(key)

    return {
      isSameNative,
      initialHead,
      stored: {
        key: stored.key,
        size: stored.size,
        contentType: stored.contentType,
        url: stored.url,
      },
      headAfterPut: headAfterPut ? { size: headAfterPut.size, contentType: headAfterPut.contentType } : null,
      bodyText,
      notModifiedCode,
      notModifiedMsg,
      preconditionFailedCode,
      preconditionFailedMsg,
      caughtOverwriteError,
      overwritten: {
        size: overwritten.size,
      },
      headAfterOverwrite: headAfterOverwrite ? { size: headAfterOverwrite.size } : null,
      overwrittenBodyText,
      headAfterDelete,
    }
  } catch (err: any) {
    return { caughtError: err.message, stack: err.stack }
  }
})`,
    )

    project.write(
      'api/r2-range.post.ts',
      `import { route } from '@olivaw/sark'
export default route().handler(async (c) => {
  const store = c.var.storage.media
  const key = 'ranges/data.txt'
  await store.put(key, new TextEncoder().encode('0123456789'))
  await store.put('ranges/empty.txt', new Uint8Array())
  try {
    const partial = await store.get(key, { range: { offset: 3, length: 4 } })
    const results: Record<string, unknown> = {
      partial: { size: partial!.size, text: await new Response(partial!.body).text() },
      missing: await store.get('ranges/missing.txt', { range: { offset: 100 } }),
    }
    for (const [name, file, options] of [
      ['pastEnd', key, { range: { offset: 100 } }],
      ['empty', 'ranges/empty.txt', { range: { offset: 0 } }],
      ['precondition', key, { range: { offset: 100 }, ifMatch: '"different"' }],
    ] as const) {
      try {
        const content = await store.get(file, options)
        await content?.body.cancel()
        results[name] = content === null ? null : 'unexpected content'
      } catch (error) {
        const failure = error as Error & { code?: string }
        results[name] = { code: failure.code, cause: String(failure.cause) }
      }
    }
    return results
  } finally {
    await store.delete(key)
    await store.delete('ranges/empty.txt')
  }
})`,
    )

    project.write(
      'api/r2-concurrent.post.ts',
      `import { route } from '@olivaw/sark'
import { StorageError } from '@olivaw/sark/storage/r2'

export default route().handler(async (c) => {
  const store = c.var.storage.media
  const key = 'race-condition/test.bin'

  // Attempt concurrent non-overwrite puts
  const results = await Promise.allSettled([
    store.put(key, new Uint8Array([1, 1, 1])),
    store.put(key, new Uint8Array([2, 2, 2])),
  ])

  let successes = 0
  let fileExistsCount = 0

  for (const r of results) {
    if (r.status === 'fulfilled') {
      successes++
    } else if (r.reason instanceof StorageError && r.reason.code === 'file_exists') {
      fileExistsCount++
    }
  }

  // Cleanup
  await store.delete(key)

  return { successes, fileExistsCount }
})`,
    )

    project.write(
      'api/r2-upload.post.ts',
      `import { route } from '@olivaw/sark'
export default route().handler(async (c) => {
  const stored = await c.var.storage.media.put('request-stream.bin', c.req.raw.body!, {
    contentLength: Number(c.req.header('content-length')),
    signal: c.req.raw.signal,
    overwrite: true,
  })
  const content = await c.var.storage.media.get(stored.key, { signal: c.req.raw.signal })
  const bytes = Array.from(await new Response(content!.body).bytes())
  await c.var.storage.media.delete(stored.key)
  return { size: stored.size, bytes }
})`,
    )

    project.write(
      'api/r2-streams.post.ts',
      `import { route } from '@olivaw/sark'
export default route().handler(async (c) => {
  const store = c.var.storage.media
  const results: Record<string, unknown> = {}
  for (const length of [2, 4]) {
    const body = new ReadableStream<Uint8Array>({ start(stream) { stream.enqueue(new Uint8Array([1, 2, 3])); stream.close() } })
    try { await store.put('mismatch-' + length, body, { contentLength: length }) }
    catch (error) { results['mismatch-' + length] = (error as { code: string }).code }
  }
  const unknown = new ReadableStream<Uint8Array>({ start(stream) { stream.enqueue(new Uint8Array([1])); stream.close() } })
  try { await store.put('unknown.bin', unknown) }
  catch (error) { results.unknown = (error as { code: string }).code }
  const cancelled = new AbortController()
  let cancellationObserved = false
  const body = new ReadableStream<Uint8Array>({
    pull(stream) { stream.enqueue(new Uint8Array([1])); cancelled.abort(new Error('Stopped upload')) },
    cancel() { cancellationObserved = true },
  }, { highWaterMark: 0 })
  try { await store.put('aborted.bin', body, { contentLength: 100, signal: cancelled.signal }) }
  catch (error) { results.aborted = (error as { code: string }).code }
  results.cancellationObserved = cancellationObserved
  results.abortedObject = await store.head('aborted.bin')

  const conflict = new ReadableStream<Uint8Array>({ start(stream) { stream.enqueue(new Uint8Array([7, 8])); stream.close() } })
  await store.put('existing.bin', new Uint8Array([1]))
  try { await store.put('existing.bin', conflict, { contentLength: 2, signal: new AbortController().signal }) }
  catch (error) { results.conflict = (error as { code: string }).code }
  const existing = await store.get('existing.bin')
  results.existing = Array.from(await new Response(existing!.body).bytes())
  await store.delete('existing.bin')
  return results
})`,
    )

    project.write(
      'vite.config.mts',
      `import { sark } from ${JSON.stringify(viteEntry)}
import { cloudflare } from '@cloudflare/vite-plugin'

export default {
  cacheDir: '.build/vite-cache',
  plugins: [
    sark({ target: 'cloudflare', appEntry: 'app.ts', apiDir: 'api' }),
    cloudflare({ viteEnvironment: { name: 'ssr' }, inspectorPort: false, persistState: false, remoteBindings: false }),
    { name: 'check-plain-r2-dependencies', generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue
        for (const id of Object.keys(output.modules)) {
          if (/aws4fetch|@aws-sdk|@smithy/.test(id)) throw new Error('Unexpected dependency in plain R2 Worker: ' + id)
        }
      }
    } },
  ],
}`,
    )

    project.write(
      'worker.ts',
      `import worker from './.build/worker'
export default worker`,
    )

    project.write(
      'wrangler.jsonc',
      JSON.stringify({
        name: 'sark-r2-test',
        main: 'worker.ts',
        compatibility_date: '2026-10-01',
        compatibility_flags: ['nodejs_compat'],
        r2_buckets: [
          {
            binding: 'MEDIA_BUCKET',
            bucket_name: 'test-media-bucket',
          },
        ],
      }),
    )

    let previewServer: PreviewServer | undefined
    try {
      const buildResult = runProjectCli(project.root, ['build'], { NODE_ENV: 'production' })
      expect(buildResult.status, buildResult.stdout + buildResult.stderr).toBe(0)

      previewServer = await preview({
        root: project.root,
        logLevel: 'silent',
        preview: { host: '127.0.0.1', port: 0 },
      })

      const workerUrl = serverUrl(previewServer.httpServer)

      // Test 1: Full operations contract on native workerd binding
      const response = await fetch(`${workerUrl}/api/r2-test`, { method: 'POST' })
      expect(response.status).toBe(200)

      const result = await response.json()
      if (result.caughtError) {
        throw new Error(`Route error: ${result.caughtError}\n${result.stack}`)
      }

      expect(result.isSameNative).toBe(true)
      expect(result.initialHead).toBeNull()
      expect(result.stored).toEqual({
        key: 'documents/report.txt',
        size: 35,
        contentType: 'text/plain',
        url: 'https://cdn.example.com/documents/report.txt',
      })
      expect(result.headAfterPut).toEqual({
        size: 35,
        contentType: 'text/plain',
      })
      expect(result.bodyText).toBe('Hello Cloudflare R2 native binding!')
      expect(result.notModifiedCode).toBe('not_modified')
      expect(result.preconditionFailedCode).toBe('precondition_failed')
      expect(result.caughtOverwriteError.code).toBe('file_exists')
      expect(result.caughtOverwriteError.message).toContain('documents/report.txt')
      expect(result.headAfterOverwrite).toEqual({
        size: 12,
      })
      expect(result.overwrittenBodyText).toBe('Updated text')
      expect(result.headAfterDelete).toBeNull()

      const ranges = await fetch(`${workerUrl}/api/r2-range`, { method: 'POST' })
      expect(ranges.status).toBe(200)
      expect(await ranges.json()).toMatchObject({
        partial: { size: 10, text: '3456' },
        missing: null,
        pastEnd: { code: 'range_not_satisfiable' },
        empty: { code: 'range_not_satisfiable' },
        precondition: { code: 'precondition_failed' },
      })

      const uploaded = await fetch(`${workerUrl}/api/r2-upload`, {
        method: 'POST',
        body: new Uint8Array([3, 4, 5]),
      })
      expect(uploaded.status).toBe(200)
      expect(await uploaded.json()).toEqual({ size: 3, bytes: [3, 4, 5] })
      const streams = await fetch(`${workerUrl}/api/r2-streams`, { method: 'POST' })
      expect(streams.status).toBe(200)
      expect(await streams.json()).toEqual({
        'mismatch-2': 'storage_error',
        'mismatch-4': 'storage_error',
        unknown: 'unsupported_operation',
        aborted: 'storage_error',
        cancellationObserved: true,
        abortedObject: null,
        conflict: 'file_exists',
        existing: [1],
      })

      // Test 2: Concurrent atomic race condition
      const concurrentRes = await fetch(`${workerUrl}/api/r2-concurrent`, { method: 'POST' })
      expect(concurrentRes.status).toBe(200)
      const concurrentResult = await concurrentRes.json()
      expect(concurrentResult.successes).toBe(1)
      expect(concurrentResult.fileExistsCount).toBe(1)
    } finally {
      if (previewServer) {
        await previewServer.close()
      }
      project.remove()
    }
  }, 45000)
  it('signs direct requests inside the built Worker without loading S3Client', async () => {
    const project = createProject()
    const endpoint = process.env.SARK_TEST_S3_ENDPOINT
    const bucket = `sark-worker-${crypto.randomUUID()}`
    const credentials = {
      accessKeyId: process.env.SARK_TEST_S3_ACCESS_KEY ?? 'sark-test-key',
      secretAccessKey: process.env.SARK_TEST_S3_SECRET_KEY ?? 'sark-test-secret-12345678',
    }
    const client = endpoint
      ? new S3Client({ endpoint, region: 'us-east-1', credentials, forcePathStyle: true })
      : undefined
    let server: PreviewServer | undefined
    try {
      if (client) await client.send(new CreateBucketCommand({ Bucket: bucket }))
      project.write(
        'app.ts',
        `import { defineApp } from '@olivaw/sark'
import { defineStorage } from '@olivaw/sark/storage/r2'
import { definePresign } from '@olivaw/sark/storage/presign'
import type { R2Bucket } from '@cloudflare/workers-types'
export const app = defineApp()
export const storage = { files: defineStorage((env: { FILES: R2Bucket }) => ({
  binding: env.FILES,
  presign: definePresign(${JSON.stringify({ endpoint: endpoint ?? 'https://example.r2.cloudflarestorage.com', bucket, region: 'us-east-1', credentials })}),
})) }`,
      )
      project.write(
        'api/sign.get.ts',
        `import { route } from '@olivaw/sark'
export default route().handler(async (c) => ({
  put: await c.var.storage.files.presign({ operation: 'put', key: '直传 +?#% (1).txt', contentType: 'text/plain' }),
  get: await c.var.storage.files.presign({ operation: 'get', key: '直传 +?#% (1).txt' }),
}))`,
      )
      project.write(
        'vite.config.mts',
        `import { sark } from '@olivaw/sark/vite'
import { cloudflare } from '@cloudflare/vite-plugin'
export default { plugins: [sark({ target: 'cloudflare' }), cloudflare({ viteEnvironment: { name: 'ssr' }, inspectorPort: false, persistState: false, remoteBindings: false }),
{ name: 'check-signing-dependencies', generateBundle(_options, bundle) {
  for (const output of Object.values(bundle)) {
    if (output.type !== 'chunk') continue
    for (const id of Object.keys(output.modules)) {
      if (/client-s3/.test(id)) throw new Error('R2 presign pulled in S3Client: ' + id)
    }
  }
}}] }`,
      )
      project.write(
        'wrangler.jsonc',
        JSON.stringify({
          name: 'sark-presign-test',
          main: '.build/worker.ts',
          compatibility_date: '2026-10-01',
          compatibility_flags: ['nodejs_compat'],
          r2_buckets: [{ binding: 'FILES', bucket_name: bucket }],
        }),
      )
      const built = runProjectCli(project.root, ['build'])
      expect(built.status, built.stdout + built.stderr).toBe(0)
      server = await preview({
        root: project.root,
        logLevel: 'silent',
        preview: { host: '127.0.0.1', port: 0 },
      })
      const response = await fetch(`${serverUrl(server.httpServer)}/api/sign`)
      expect(response.status).toBe(200)
      const signed = await response.json()
      expect(new URL(signed.put.url).searchParams.get('X-Amz-SignedHeaders')).toBe(
        'content-type;host',
      )
      if (client) {
        const put = await fetch(signed.put.url, {
          method: signed.put.method,
          headers: signed.put.headers,
          body: new TextEncoder().encode('Worker signed upload'),
        })
        expect(put.status, await put.text()).toBe(200)
        const get = await fetch(signed.get.url)
        expect(get.status).toBe(200)
        expect(await get.text()).toBe('Worker signed upload')
        const wrong = await fetch(signed.put.url, {
          method: 'PUT',
          headers: { 'content-type': 'image/png' },
          body: new Uint8Array([1]),
        })
        expect(wrong.status).toBe(403)
      }
    } finally {
      await server?.close()
      project.remove()
      if (client) {
        try {
          await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: '直传 +?#% (1).txt' }))
          await client.send(new DeleteBucketCommand({ Bucket: bucket }))
        } finally {
          client.destroy()
        }
      }
    }
  }, 45000)
})
