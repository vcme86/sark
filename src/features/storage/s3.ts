/**
 * AWS S3-compatible object storage provider.
 *
 * @module
 */

import { Readable } from 'node:stream'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'

import {
  AbortMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
  S3ServiceException,
} from '@aws-sdk/client-s3'
import { getMimeType } from 'hono/utils/mime'

import { type BaseDeclaration, evaluateDeclaration, type RequiresEnv } from '../../app/declaration'
import type { InferResource, ResourceAssembly } from '../../app/resource'
import {
  type PresignDeclaration,
  resolvePresignRequest,
  type S3PresignConfig,
  validateS3PresignConfig,
} from './presign-config'
import {
  buildPublicUrl,
  type FileBody,
  type FileStore,
  type GetOptions,
  type PresignOptions,
  type PresignResult,
  type PutOptions,
  StorageError,
  type StoredContent,
  type StoredFile,
  validateStorageKey,
  validateStorageRange,
} from './types'

/** Configuration options for S3 storage. */
export interface S3StorageConfig<
  Presign extends PresignDeclaration<S3PresignConfig> | undefined = undefined,
> {
  /** Target bucket name. */
  bucket: string | undefined
  /** AWS or compatible storage region. */
  region: string | undefined
  /** S3-compatible service endpoint URL. */
  endpoint?: string
  /** Explicit credentials; omission uses the AWS SDK default credential chain. */
  credentials?: {
    accessKeyId: string | undefined
    secretAccessKey: string | undefined
    sessionToken?: string
  }
  /** Whether to force path-style URLs (useful for local S3 and MinIO). */
  forcePathStyle?: boolean
  /** Base public URL for asset link generation. */
  publicUrl?: string
  /** Presign capability declaration. */
  presign?: Presign
}

/** Extended FileStore exposing the native S3Client. */
export interface S3FileStore extends FileStore {
  /** Raw SDK S3Client instance. */
  readonly native: S3Client
}

/** S3 FileStore with presign capability. */
export interface S3PresignedFileStore extends S3FileStore {
  /** Signs a direct URL for client upload or download. */
  presign(options: PresignOptions): Promise<PresignResult>
}

/** Declaration representing an S3 storage configuration. */
export interface S3StorageDeclaration<
  Presign extends PresignDeclaration<S3PresignConfig> | undefined = undefined,
>
  extends
    ResourceAssembly<Presign extends PresignDeclaration ? S3PresignedFileStore : S3FileStore>,
    BaseDeclaration<'storage', S3StorageConfig<Presign>> {
  readonly driver: 's3'
}

/**
 * Declares an AWS S3 or compatible object storage bucket.
 *
 * @param config - S3 connection settings, credentials, bucket name, and optional presigning.
 * @returns Storage declaration retaining concrete S3 configuration and instance cleanup.
 */
export function defineStorage<
  const Presign extends PresignDeclaration<S3PresignConfig> | undefined = undefined,
>(config: S3StorageConfig<Presign>): S3StorageDeclaration<Presign>

/**
 * Declares S3 storage and presigning resolved once during Node application creation.
 *
 * @param factory - Receives the instance environment and returns storage and signing settings.
 * @returns A declaration retaining the signing capability and environment requirements.
 */
export function defineStorage<E, const Presign extends PresignDeclaration<S3PresignConfig>>(
  factory: (env: E) => S3StorageConfig<Presign>,
): S3StorageDeclaration<Presign> & RequiresEnv<E>

/**
 * Declares S3 storage resolved once during Node application creation.
 *
 * @param factory - Receives the instance environment and returns storage settings.
 * @returns A declaration retaining the factory's environment requirements.
 */
export function defineStorage<E = unknown>(
  factory: (env: E) => S3StorageConfig<undefined>,
): S3StorageDeclaration<undefined> & RequiresEnv<E>

export function defineStorage<
  const Presign extends PresignDeclaration<S3PresignConfig> | undefined = undefined,
>(
  input: S3StorageConfig<Presign> | ((env: any) => S3StorageConfig<Presign>),
): S3StorageDeclaration<Presign> {
  return {
    kind: 'storage',
    driver: 's3',
    target: 'node',
    value: input,
    isFactory: typeof input === 'function',
    createStatic: async (env) => {
      const config = evaluateDeclaration(input, env, 'storage')
      if (!config.bucket || typeof config.bucket !== 'string') {
        throw new StorageError('storage_error', 'S3 storage requires a non-empty bucket name.')
      }
      if (!config.region || typeof config.region !== 'string') {
        throw new StorageError('storage_error', 'S3 storage requires a non-empty region.')
      }

      const clientConfig: S3ClientConfig = {
        region: config.region,
        endpoint: config.endpoint,
        forcePathStyle: config.forcePathStyle,
      }

      if (config.credentials) {
        if (!config.credentials.accessKeyId || !config.credentials.secretAccessKey) {
          throw new StorageError(
            'storage_error',
            'S3 credentials require both accessKeyId and secretAccessKey.',
          )
        }
        clientConfig.credentials = {
          accessKeyId: config.credentials.accessKeyId,
          secretAccessKey: config.credentials.secretAccessKey,
          sessionToken: config.credentials.sessionToken,
        }
      }

      const presignConfig = config.presign
        ? validateS3PresignConfig(config.presign.options)
        : undefined
      const client = new S3Client(clientConfig)

      const store: S3FileStore = config.presign
        ? new S3PresignedFileStoreImpl(
            client,
            config.bucket,
            config.publicUrl,
            presignConfig!.expiresIn,
          )
        : new S3FileStoreBase(client, config.bucket, config.publicUrl)

      return {
        value: store as InferResource<S3StorageDeclaration<Presign>>,
        dispose: () => {
          client.destroy()
        },
      }
    },
  }
}

class S3FileStoreBase implements S3FileStore {
  readonly native: S3Client
  protected readonly bucket: string
  protected readonly publicUrl?: string

  constructor(client: S3Client, bucket: string, publicUrl?: string) {
    this.native = client
    this.bucket = bucket
    this.publicUrl = publicUrl
  }

  async put(key: string, body: FileBody, options?: PutOptions): Promise<StoredFile> {
    const validKey = validateStorageKey(key)
    const mime = options?.contentType ?? getMimeType(validKey) ?? 'application/octet-stream'

    const params = {
      Bucket: this.bucket,
      Key: validKey,
      ContentType: mime,
      IfNoneMatch: options?.overwrite ? undefined : ('*' as const),
    }
    try {
      let size: number
      let etag: string | undefined
      if (body instanceof ReadableStream && options?.contentLength === undefined) {
        ;({ size, etag } = await uploadUnknownStream(this.native, params, body, options?.signal))
      } else {
        let payload: Uint8Array | Readable
        if (body instanceof Uint8Array) {
          payload = body
          size = body.byteLength
        } else if (body instanceof ArrayBuffer) {
          payload = new Uint8Array(body)
          size = payload.byteLength
        } else if (body instanceof Blob) {
          payload = Readable.fromWeb(body.stream() as unknown as NodeReadableStream, {
            signal: options?.signal,
          })
          size = body.size
        } else {
          size = options!.contentLength!
          if (!Number.isSafeInteger(size) || size < 0) {
            throw new StorageError(
              'storage_error',
              'contentLength must be a non-negative integer of bytes.',
            )
          }
          payload = Readable.fromWeb(body as unknown as NodeReadableStream, {
            signal: options?.signal,
          })
        }
        try {
          const response = await this.native.send(
            new PutObjectCommand({
              ...params,
              Body: payload,
              ContentLength: size,
            }),
            { abortSignal: options?.signal },
          )
          etag = response.ETag
        } finally {
          if (payload instanceof Readable) payload.destroy()
        }
      }
      return {
        key: validKey,
        size,
        contentType: mime,
        etag,
        url: buildPublicUrl(this.publicUrl, validKey),
      }
    } catch (error) {
      if (error instanceof StorageError) throw error
      if (
        !options?.overwrite &&
        error instanceof S3ServiceException &&
        error.$metadata.httpStatusCode === 412
      ) {
        throw new StorageError('file_exists', `S3 object already exists: ${validKey}`, {
          cause: error,
        })
      }
      throw new StorageError('storage_error', `S3 put failed: ${String(error)}`, { cause: error })
    }
  }

  async head(key: string): Promise<StoredFile | null> {
    const validKey = validateStorageKey(key)
    try {
      const command = new HeadObjectCommand({
        Bucket: this.bucket,
        Key: validKey,
      })
      const response = await this.native.send(command)
      const mime = response.ContentType ?? getMimeType(validKey) ?? 'application/octet-stream'

      return {
        key: validKey,
        size: response.ContentLength ?? 0,
        contentType: mime,
        etag: response.ETag,
        lastModified: response.LastModified,
        url: buildPublicUrl(this.publicUrl, validKey),
      }
    } catch (err) {
      if (err instanceof StorageError) throw err
      if (err instanceof S3ServiceException && err.$metadata.httpStatusCode === 404) {
        return null
      }
      throw new StorageError('storage_error', `S3 head failed: ${String(err)}`, {
        cause: err,
      })
    }
  }

  async get(key: string, options?: GetOptions): Promise<StoredContent | null> {
    const validKey = validateStorageKey(key)

    let rangeHeader: string | undefined
    if (options?.range) {
      const { offset, length } = options.range
      validateStorageRange(options.range)
      rangeHeader =
        length !== undefined ? `bytes=${offset}-${offset + length - 1}` : `bytes=${offset}-`
    }

    try {
      const command = new GetObjectCommand({
        Bucket: this.bucket,
        Key: validKey,
        Range: rangeHeader,
        IfMatch: options?.ifMatch,
        IfNoneMatch: options?.ifNoneMatch,
      })

      const response = await this.native.send(command, {
        abortSignal: options?.signal,
      })

      const mime = response.ContentType ?? getMimeType(validKey) ?? 'application/octet-stream'
      if (!response.Body) throw new StorageError('storage_error', 'S3 returned no object body.')
      const stream = response.Body.transformToWebStream()

      // Ensure consistent full object size semantics across backends
      let fullSize = response.ContentLength ?? 0
      if (response.ContentRange) {
        const match = /\/(\d+)$/.exec(response.ContentRange)
        if (match) {
          fullSize = Number(match[1])
        }
      }

      return {
        key: validKey,
        size: fullSize,
        contentType: mime,
        etag: response.ETag,
        lastModified: response.LastModified,
        url: buildPublicUrl(this.publicUrl, validKey),
        body: stream,
      }
    } catch (err) {
      if (err instanceof StorageError) throw err
      const status = err instanceof S3ServiceException ? err.$metadata.httpStatusCode : undefined
      if (status === 404) return null
      if (status === 412) {
        throw new StorageError('precondition_failed', 'If-Match condition failed', { cause: err })
      }
      if (status === 304) {
        throw new StorageError('not_modified', 'If-None-Match condition matched', { cause: err })
      }
      if (status === 416) {
        throw new StorageError('range_not_satisfiable', 'Requested range is not satisfiable', {
          cause: err,
        })
      }
      throw new StorageError('storage_error', `S3 get failed: ${String(err)}`, {
        cause: err,
      })
    }
  }

  async delete(key: string): Promise<void> {
    const validKey = validateStorageKey(key)
    try {
      const command = new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: validKey,
      })
      await this.native.send(command)
    } catch (err) {
      if (err instanceof StorageError) throw err
      if (err instanceof S3ServiceException && err.$metadata.httpStatusCode === 404) return
      throw new StorageError('storage_error', `S3 delete failed: ${String(err)}`, {
        cause: err,
      })
    }
  }
}

/** S3 file store with URL signing through its existing client. */
class S3PresignedFileStoreImpl extends S3FileStoreBase implements S3PresignedFileStore {
  private readonly presignMaxExpires: number

  constructor(
    client: S3Client,
    bucket: string,
    publicUrl: string | undefined,
    presignMaxExpires: number,
  ) {
    super(client, bucket, publicUrl)
    this.presignMaxExpires = presignMaxExpires
  }

  async presign(options: PresignOptions): Promise<PresignResult> {
    const {
      key: validKey,
      expiresIn: requestedExpires,
      headers,
      method,
    } = resolvePresignRequest(options, this.presignMaxExpires)
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner')
    const signableHeaders = new Set(Object.keys(headers))
    const command =
      method === 'PUT'
        ? new PutObjectCommand({
            Bucket: this.bucket,
            Key: validKey,
            ContentType: headers['content-type'],
          })
        : new GetObjectCommand({ Bucket: this.bucket, Key: validKey })

    const signingDate = new Date()
    const url = await getSignedUrl(this.native, command, {
      expiresIn: requestedExpires,
      signableHeaders,
      signingDate,
    })

    const expiresAt = Math.floor(signingDate.getTime() / 1000) + requestedExpires

    return {
      url,
      method,
      headers,
      expiresAt,
    }
  }
}

/** Uploads an unknown-length source using the SDK's bounded multipart uploader. */
async function uploadUnknownStream(
  client: S3Client,
  params: { Bucket: string; Key: string; ContentType: string; IfNoneMatch?: '*' },
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted()
  const { Upload } = await import('@aws-sdk/lib-storage')
  let size = 0
  const source = Readable.fromWeb(body as unknown as NodeReadableStream, { signal })
  const counted = Readable.from(
    (async function* () {
      for await (const chunk of source) {
        size += chunk.byteLength
        yield chunk
      }
    })(),
  )
  // Upload.abort() rejects before its background work settles, and some of its
  // commands omit the signal. Scope cancellation to SDK sends without mutating
  // the shared client; done() can then settle before owned multipart cleanup.
  let uploadClient = client
  if (signal) {
    const send = new Proxy(client.send, {
      apply(target, _receiver, [command, options]) {
        return Reflect.apply(target, client, [command, { ...options, abortSignal: signal }])
      },
    })
    uploadClient = new Proxy(client, {
      get(target, property) {
        return property === 'send' ? send : Reflect.get(target, property, target)
      },
    })
  }
  const upload = new Upload({
    client: uploadClient,
    params: { ...params, Body: counted },
    queueSize: 1,
    // Own cleanup for every failure, including CompleteMultipartUpload rejection.
    // The SDK only aborts failures that occur while uploading individual parts.
    leavePartsOnError: true,
  })
  try {
    const result = await upload.done()
    return { size, etag: result.ETag }
  } catch (error) {
    if (upload.uploadId) {
      try {
        await client.send(
          new AbortMultipartUploadCommand({
            Bucket: params.Bucket,
            Key: params.Key,
            UploadId: upload.uploadId,
          }),
        )
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'S3 upload and multipart cleanup failed.', {
          cause: cleanupError,
        })
      }
    }
    throw error
  } finally {
    counted.destroy()
    source.destroy()
  }
}
