import type { S3Client } from '@aws-sdk/client-s3'
import type { R2Bucket } from '@cloudflare/workers-types'
import { describe, expectTypeOf, it } from 'vitest'

import { createApp } from '../../../src/app/create'
import { createDefinition } from '../../../src/app/definition'
import type { InferResource } from '../../../src/app/resource'
import { createStorageAssembly } from '../../../src/features/storage/assembly'
import { defineStorage as defineLocalStorage } from '../../../src/features/storage/local'
import { definePresign } from '../../../src/features/storage/presign'
import { defineStorage as defineR2Storage } from '../../../src/features/storage/r2'
import { defineStorage as defineS3Storage } from '../../../src/features/storage/s3'
import type { FileStore, PresignResult } from '../../../src/features/storage/types'

describe('Storage Type Contracts', () => {
  it('infers exact native backend types for S3 and R2 while local has no native', () => {
    const localDecl = defineLocalStorage({ dir: './uploads' })
    type LocalInferred = InferResource<typeof localDecl>
    expectTypeOf<LocalInferred>().toMatchTypeOf<FileStore>()
    // Local has no native property
    expectTypeOf<LocalInferred>().not.toHaveProperty('native')

    const r2Decl = defineR2Storage({ binding: {} as R2Bucket })
    type R2Inferred = InferResource<typeof r2Decl>
    expectTypeOf<R2Inferred>().toMatchTypeOf<FileStore>()
    expectTypeOf<R2Inferred['native']>().toEqualTypeOf<R2Bucket>()

    const s3Decl = defineS3Storage({
      bucket: 'test-bucket',
      region: 'us-east-1',
    })
    type S3Inferred = InferResource<typeof s3Decl>
    expectTypeOf<S3Inferred>().toMatchTypeOf<FileStore>()
    expectTypeOf<S3Inferred['native']>().toEqualTypeOf<S3Client>()
  })

  it('adds presign method only when presign capability is declared', () => {
    // S3 without presign
    const s3NoPresign = defineS3Storage({
      bucket: 'b',
      region: 'r',
    })
    type S3NoPresignStore = InferResource<typeof s3NoPresign>
    expectTypeOf<S3NoPresignStore>().not.toHaveProperty('presign')

    // S3 with presign
    const s3WithPresign = defineS3Storage({
      bucket: 'b',
      region: 'r',
      presign: definePresign({ expiresIn: 120 }),
    })
    type S3WithPresignStore = InferResource<typeof s3WithPresign>
    expectTypeOf<S3WithPresignStore>().toHaveProperty('presign')
    expectTypeOf<S3WithPresignStore['presign']>().toBeFunction()
    expectTypeOf<
      ReturnType<S3WithPresignStore['presign']>
    >().resolves.toEqualTypeOf<PresignResult>()

    // R2 without presign
    const r2NoPresign = defineR2Storage({ binding: {} as R2Bucket })
    type R2NoPresignStore = InferResource<typeof r2NoPresign>
    expectTypeOf<R2NoPresignStore>().not.toHaveProperty('presign')

    // R2 with presign
    const r2WithPresign = defineR2Storage({
      binding: {} as R2Bucket,
      presign: definePresign({
        endpoint: 'https://r2.test',
        bucket: 'b',
        credentials: { accessKeyId: 'k', secretAccessKey: 's' },
      }),
    })
    type R2WithPresignStore = InferResource<typeof r2WithPresign>
    expectTypeOf<R2WithPresignStore>().toHaveProperty('presign')
    expectTypeOf<R2WithPresignStore['presign']>().toBeFunction()
  })

  it('infers exact storage map for named dictionary declarations', () => {
    const storage = {
      localFiles: defineLocalStorage({ dir: './data' }),
      cloudMedia: defineS3Storage({
        bucket: 'media',
        region: 'us-east-1',
        presign: definePresign(),
      }),
    }

    type NamedStorage = {
      [K in keyof typeof storage]: InferResource<(typeof storage)[K]>
    }

    expectTypeOf<NamedStorage['localFiles']>().toMatchTypeOf<FileStore>()
    expectTypeOf<NamedStorage['localFiles']>().not.toHaveProperty('native')
    expectTypeOf<NamedStorage['cloudMedia']>().toMatchTypeOf<FileStore>()
    expectTypeOf<NamedStorage['cloudMedia']['native']>().toEqualTypeOf<S3Client>()
    expectTypeOf<NamedStorage['cloudMedia']>().toHaveProperty('presign')
  })

  it('synthesizes environment requirements from storage declarations onto createApp', () => {
    interface UploadEnv {
      UPLOAD_DIRECTORY: string
    }

    interface WorkerEnv {
      MY_BUCKET: R2Bucket
    }

    // Factory with presign and typed environment
    const r2FactoryWithPresign = defineR2Storage((env: WorkerEnv) => ({
      binding: env.MY_BUCKET,
      presign: definePresign({
        endpoint: 'https://r2.example.com',
        bucket: 'media',
        credentials: { accessKeyId: 'key', secretAccessKey: 'secret' },
      }),
    }))
    type R2FactoryStore = InferResource<typeof r2FactoryWithPresign>
    expectTypeOf<R2FactoryStore>().toHaveProperty('presign')
    expectTypeOf<R2FactoryStore['native']>().toEqualTypeOf<R2Bucket>()

    const storage = {
      local: defineLocalStorage((env: UploadEnv) => ({ dir: env.UPLOAD_DIRECTORY })),
    }

    const assembly = createStorageAssembly(storage)
    const definition = createDefinition({
      resources: {
        storage: assembly,
      },
    })

    const typeOnly = () => {
      // When storage factory requires UploadEnv, createApp MUST require { env: UploadEnv }
      // @ts-expect-error - createApp without options is rejected
      void createApp(definition)

      // @ts-expect-error - createApp with empty env is rejected
      void createApp(definition, { env: {} })

      // Valid invocation with required UploadEnv passes
      void createApp(definition, { env: { UPLOAD_DIRECTORY: '/tmp' } })
    }
    void typeOnly
  })
})
