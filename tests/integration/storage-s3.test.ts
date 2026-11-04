import { createHash } from 'node:crypto'

import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3'
import type { R2Bucket } from '@cloudflare/workers-types'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { definePresign } from '../../src/features/storage/presign'
import { defineStorage as defineR2Storage } from '../../src/features/storage/r2'
import { defineStorage, type S3PresignedFileStore } from '../../src/features/storage/s3'

// Use a dedicated S3-compatible service; each run owns and removes its own bucket.
const endpoint = process.env.SARK_TEST_S3_ENDPOINT
const credentials = {
  accessKeyId: process.env.SARK_TEST_S3_ACCESS_KEY ?? 'sark-test-key',
  secretAccessKey: process.env.SARK_TEST_S3_SECRET_KEY ?? 'sark-test-secret-12345678',
}
const bucket = `sark-test-${crypto.randomUUID()}`
const region = 'us-east-1'

function streamOf(bytes: Uint8Array) {
  let offset = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.byteLength) return controller.close()
      const end = Math.min(offset + 65536, bytes.byteLength)
      controller.enqueue(bytes.subarray(offset, end))
      offset = end
    },
  })
}

describe.skipIf(!endpoint)('S3 storage against an independent service', () => {
  let store: S3PresignedFileStore
  beforeAll(async () => {
    const resource = await defineStorage({
      endpoint,
      bucket,
      region,
      credentials,
      forcePathStyle: true,
      presign: definePresign({ expiresIn: 60 }),
    }).createStatic!(undefined, { signal: new AbortController().signal })
    store = resource.value
    await store.native.send(new CreateBucketCommand({ Bucket: bucket }))
  })

  afterAll(async () => {
    if (!store) return
    try {
      const objects = await store.native.send(new ListObjectsV2Command({ Bucket: bucket }))
      if (objects.Contents?.length) {
        await store.native.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: objects.Contents.map(({ Key }) => ({ Key })) },
          }),
        )
      }
      await store.native.send(new DeleteBucketCommand({ Bucket: bucket }))
    } finally {
      store.native.destroy()
    }
  })

  it('preserves content, metadata, ranges, and conditional read errors', async () => {
    const key = 'documents/测试 #?%.txt'
    expect(await store.get(key)).toBeNull()
    const result = await store.put(key, new Blob(['0123456789']))
    expect(result.size).toBe(10)
    expect(await store.head(key)).toMatchObject({ size: 10, etag: result.etag })
    const content = await store.get(key, { range: { offset: 3, length: 4 } })
    expect(content!.size).toBe(10)
    expect(await new Response(content!.body).text()).toBe('3456')
    await expect(store.get(key, { ifNoneMatch: result.etag })).rejects.toMatchObject({
      code: 'not_modified',
    })
    await expect(store.get(key, { ifMatch: '"different"' })).rejects.toMatchObject({
      code: 'precondition_failed',
    })
    await expect(store.get(key, { range: { offset: 99 } })).rejects.toMatchObject({
      code: 'range_not_satisfiable',
    })
    await store.delete(key)
    await store.delete(key)
    expect(await store.head(key)).toBeNull()
  })

  it('streams multiple parts and atomically refuses concurrent overwrites', async () => {
    const bytes = new Uint8Array(6 * 1024 * 1024 + 17).fill(37)
    const outcomes = await Promise.allSettled([
      store.put('multipart.bin', streamOf(bytes)),
      store.put('multipart.bin', streamOf(bytes)),
    ])
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'file_exists' },
    })
    const content = await store.get('multipart.bin')
    expect(content!.size).toBe(bytes.byteLength)
    const downloaded = await new Response(content!.body).bytes()
    expect(downloaded.byteLength).toBe(bytes.byteLength)
    expect(createHash('sha256').update(downloaded).digest('hex')).toBe(
      createHash('sha256').update(bytes).digest('hex'),
    )
    expect(
      (await store.native.send(new ListMultipartUploadsCommand({ Bucket: bucket }))).Uploads ?? [],
    ).toHaveLength(0)
  })

  it('cancels the input and removes incomplete parts on abort', async () => {
    const controller = new AbortController()
    let sent = 0
    let cancelled = false
    let uploadedPart = false
    let transportSignalObserved = false
    const transport = store.native.config.requestHandler
    const handle = transport.handle
    transport.handle = (request, options) => {
      if (request.query?.partNumber !== undefined) {
        transportSignalObserved = Boolean(
          options && 'abortSignal' in options && options.abortSignal === controller.signal,
        )
      }
      return handle.call(transport, request, options)
    }
    store.native.middlewareStack.add(
      (next, context) => async (args) => {
        const result = await next(args)
        if (context.commandName === 'UploadPartCommand') {
          uploadedPart = true
          controller.abort(new Error('Upload cancelled'))
        }
        return result
      },
      { step: 'initialize', name: 'cancelAfterFirstPart' },
    )
    const body = new ReadableStream<Uint8Array>({
      pull(stream) {
        if (sent >= 12 * 1024 * 1024) return stream.close()
        sent += 65536
        stream.enqueue(new Uint8Array(65536))
      },
      cancel() {
        cancelled = true
      },
    })
    try {
      await expect(
        store.put('cancelled.bin', body, { signal: controller.signal }),
      ).rejects.toMatchObject({ code: 'storage_error' })
    } finally {
      store.native.middlewareStack.remove('cancelAfterFirstPart')
      transport.handle = handle
    }
    expect(uploadedPart).toBe(true)
    expect(transportSignalObserved).toBe(true)
    expect(cancelled).toBe(true)
    expect(await store.head('cancelled.bin')).toBeNull()
    expect(
      (await store.native.send(new ListMultipartUploadsCommand({ Bucket: bucket }))).Uploads ?? [],
    ).toHaveLength(0)
  })

  it('validates both signing paths using actual PUT, GET, and tampered signatures', async () => {
    const r2 = defineR2Storage({
      // Signing never calls the binding; HTTP verification is performed by the S3 service.
      binding: {} as R2Bucket,
      presign: definePresign({ endpoint: endpoint!, bucket, region, credentials, expiresIn: 60 }),
    }).createForEvent!(undefined)
    const portable = (await r2).value
    for (const [name, signer] of [
      ['s3', store],
      ['portable', portable],
    ] as const) {
      const key = `${name}/中文 &+?#% (1).txt`
      const signed = await signer.presign({ operation: 'put', key, contentType: 'text/plain' })
      const uploaded = await fetch(signed.url, {
        method: signed.method,
        headers: signed.headers,
        body: new TextEncoder().encode('signed content'),
      })
      expect(uploaded.status, await uploaded.text()).toBe(200)
      const wrongType = await fetch(signed.url, {
        method: 'PUT',
        headers: { 'content-type': 'image/png' },
        body: new Uint8Array([1]),
      })
      expect(wrongType.status).toBe(403)
      const read = await signer.presign({ operation: 'get', key })
      const downloaded = await fetch(read.url)
      expect(downloaded.status).toBe(200)
      expect(await downloaded.text()).toBe('signed content')
      const tampered = new URL(read.url)
      const signature = tampered.searchParams.get('X-Amz-Signature')!
      tampered.searchParams.set(
        'X-Amz-Signature',
        `${signature[0] === '0' ? '1' : '0'}${signature.slice(1)}`,
      )
      expect((await fetch(tampered)).status).toBe(403)
    }
  })
})
