import type { R2Bucket } from '@cloudflare/workers-types'
import { describe, expect, it } from 'vitest'

import { definePresign } from '../../src/features/storage/presign'
import { defineStorage as defineR2Storage } from '../../src/features/storage/r2'
import { StorageError } from '../../src/features/storage/types'

describe('Cloudflare R2 Presign & Validation Contract', () => {
  it('throws StorageError on missing R2Bucket binding', async () => {
    const decl = defineR2Storage((env: any) => ({
      binding: env.MISSING_BUCKET,
    }))

    await expect(decl.createForEvent!({})).rejects.toThrow(StorageError)
  })

  it('generates presigned URLs using the AWS standalone presigner', async () => {
    // Dummy binding reference - presign generates signed S3 API URLs without invoking the binding
    const dummyBucket = {} as R2Bucket

    const decl = defineR2Storage({
      binding: dummyBucket,
      presign: definePresign({
        endpoint: 'https://test-account.r2.cloudflarestorage.com',
        bucket: 'media-bucket',
        credentials: {
          accessKeyId: 'r2-access-key',
          secretAccessKey: 'r2-secret-key-1234567890',
        },
        expiresIn: 120,
      }),
    })

    const r2Store = (await decl.createForEvent!({})).value
    expect(typeof r2Store.presign).toBe('function')

    const presignedPut = await r2Store.presign({
      operation: 'put',
      key: 'uploads/avatar.png',
      contentType: 'image/png',
      expiresIn: 60,
    })

    expect(presignedPut.method).toBe('PUT')
    expect(presignedPut.url).toContain(
      'https://test-account.r2.cloudflarestorage.com/media-bucket/uploads/avatar.png',
    )
    expect(presignedPut.url).toContain('X-Amz-Signature=')
    expect(presignedPut.url).toContain('X-Amz-Algorithm=AWS4-HMAC-SHA256')
    expect(presignedPut.url).toContain('X-Amz-Expires=60')
    expect(presignedPut.headers['content-type']).toBe('image/png')
    expect(presignedPut.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000))

    const presignedGet = await r2Store.presign({
      operation: 'get',
      key: 'uploads/avatar.png',
      expiresIn: 30,
    })

    expect(presignedGet.method).toBe('GET')
    expect(presignedGet.url).toContain(
      'https://test-account.r2.cloudflarestorage.com/media-bucket/uploads/avatar.png',
    )
    expect(presignedGet.url).toContain('X-Amz-Expires=30')
  })

  it('rejects presign request when requested expiresIn exceeds configured maximum', async () => {
    const dummyBucket = {} as R2Bucket
    const decl = defineR2Storage({
      binding: dummyBucket,
      presign: definePresign({
        endpoint: 'https://test-account.r2.cloudflarestorage.com',
        bucket: 'media-bucket',
        credentials: {
          accessKeyId: 'r2-access-key',
          secretAccessKey: 'r2-secret-key-1234567890',
        },
        expiresIn: 60,
      }),
    })

    const r2Store = (await decl.createForEvent!({})).value
    await expect(
      r2Store.presign({
        operation: 'get',
        key: 'file.txt',
        expiresIn: 120, // exceeds 60
      }),
    ).rejects.toThrow(StorageError)
  })
})
