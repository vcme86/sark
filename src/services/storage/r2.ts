/**
 * Cloudflare Workers R2 object storage provider.
 *
 * @module
 */

import type { R2Bucket, R2GetOptions, R2PutOptions } from '@cloudflare/workers-types'
import { getMimeType } from 'hono/utils/mime'

import { type BaseDeclaration, evaluateDeclaration, type RequiresEnv } from '../../core/declaration'
import type { InferResource, ResourceAssembly } from '../../core/resource'
import { matchesETag } from '../../http/etag'
import {
  type PresignDeclaration,
  type R2PresignConfig,
  validateR2PresignConfig,
} from './presign-config'
import {
  buildPublicUrl,
  type FileBody,
  type FileStore,
  type GetOptions,
  type PresignedResult,
  type PresignOptions,
  type PutOptions,
  StorageError,
  type StoredContent,
  type StoredFile,
  validateStorageKey,
  validateStorageRange,
} from './types'

/** Configuration options for Cloudflare R2 storage. */
export interface R2StorageConfig<
  Presign extends PresignDeclaration<R2PresignConfig> | undefined = undefined,
> {
  /** R2Bucket binding supplied by the application environment. */
  binding: R2Bucket | undefined
  /** Base public URL for asset link generation. */
  publicUrl?: string
  /** Presign capability declaration. */
  presign?: Presign
}

/** Extended FileStore exposing the native R2Bucket binding. */
export interface R2FileStore extends FileStore {
  /** Cloudflare native R2Bucket binding. */
  readonly native: R2Bucket
}

/** R2 FileStore with presign capability. */
export interface R2PresignedFileStore extends R2FileStore {
  /** Signs a direct URL for client upload or download via S3-compatible API. */
  presign(options: PresignOptions): Promise<PresignedResult>
}

/** Declaration representing an R2 storage configuration. */
export interface R2StorageDeclaration<
  Presign extends PresignDeclaration<R2PresignConfig> | undefined = undefined,
>
  extends
    ResourceAssembly<Presign extends PresignDeclaration ? R2PresignedFileStore : R2FileStore>,
    BaseDeclaration<'storage', R2StorageConfig<Presign>> {
  readonly driver: 'r2'
}

// Workers provides this stream globally; its readable side retains the exact byte length.
declare const FixedLengthStream: new (length: number) => TransformStream<Uint8Array, Uint8Array>

class R2FileStoreBase implements R2FileStore {
  readonly native: R2Bucket
  protected readonly publicUrl?: string

  constructor(bucket: R2Bucket, publicUrl?: string) {
    this.native = bucket
    this.publicUrl = publicUrl
  }

  async put(key: string, body: FileBody, options?: PutOptions): Promise<StoredFile> {
    if (options?.signal?.aborted) {
      throw new StorageError('storage_error', 'R2 operation aborted.', {
        cause: options.signal.reason,
      })
    }

    const validKey = validateStorageKey(key)
    const mime = options?.contentType ?? getMimeType(validKey) ?? 'application/octet-stream'

    let payload = body
    let transfer: Promise<{ ok: true } | { ok: false; error: unknown }> | undefined
    let cancellation: AbortController | undefined
    if (
      body instanceof ReadableStream &&
      (options?.signal || options?.contentLength !== undefined)
    ) {
      const length = options?.contentLength
      if (length === undefined) {
        throw new StorageError(
          'unsupported_operation',
          'R2 stream cancellation requires contentLength to preserve the native fixed-length stream.',
        )
      }
      if (!Number.isSafeInteger(length) || length < 0) {
        throw new StorageError(
          'storage_error',
          'contentLength must be a non-negative integer of bytes.',
        )
      }
      const fixed = new FixedLengthStream(length)
      cancellation = new AbortController()
      const signal = options?.signal
        ? AbortSignal.any([options.signal, cancellation.signal])
        : cancellation.signal
      transfer = body.pipeTo(fixed.writable, { signal }).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      )
      payload = fixed.readable
    }

    const r2Options: R2PutOptions = {
      httpMetadata: {
        contentType: mime,
      },
      onlyIf: options?.overwrite ? undefined : { etagDoesNotMatch: '*' },
    }

    try {
      const result = await this.native.put(
        validKey,
        payload as Parameters<R2Bucket['put']>[1],
        r2Options,
      )
      if (!result) {
        // When onlyIf condition fails, R2 returns null
        throw new StorageError(
          'file_exists',
          `R2 object already exists and overwrite is false: ${validKey}`,
        )
      }

      const transferred = await transfer
      if (transferred && !transferred.ok) throw transferred.error

      return {
        key: validKey,
        size: result.size,
        contentType: mime,
        etag: result.httpEtag,
        lastModified: result.uploaded,
        url: buildPublicUrl(this.publicUrl, validKey),
      }
    } catch (err) {
      cancellation?.abort(err)
      await transfer
      if (err instanceof StorageError) throw err
      const code =
        err instanceof Error &&
        err.message.startsWith('Provided readable stream must have a known length')
          ? 'unsupported_operation'
          : 'storage_error'
      throw new StorageError(code, `R2 put failed: ${String(err)}`, { cause: err })
    }
  }

  async head(key: string): Promise<StoredFile | null> {
    const validKey = validateStorageKey(key)
    try {
      const object = await this.native.head(validKey)
      if (!object) return null
      const mime =
        object.httpMetadata?.contentType ?? getMimeType(validKey) ?? 'application/octet-stream'

      return {
        key: validKey,
        size: object.size,
        contentType: mime,
        etag: object.httpEtag,
        lastModified: object.uploaded,
        url: buildPublicUrl(this.publicUrl, validKey),
      }
    } catch (err) {
      if (err instanceof StorageError) throw err
      throw new StorageError('storage_error', `R2 head failed: ${String(err)}`, {
        cause: err,
      })
    }
  }

  async get(key: string, options?: GetOptions): Promise<StoredContent | null> {
    if (options?.signal?.aborted) {
      throw new StorageError('storage_error', 'R2 operation aborted.', {
        cause: options.signal.reason,
      })
    }

    const validKey = validateStorageKey(key)

    const r2Options: R2GetOptions = {}
    if (options?.range) {
      const { offset, length } = options.range
      validateStorageRange(options.range)
      r2Options.range = {
        offset,
        length,
      }
    }

    if (options?.ifMatch || options?.ifNoneMatch) {
      const headers = new Headers()
      if (options.ifMatch) headers.set('if-match', options.ifMatch)
      if (options.ifNoneMatch) headers.set('if-none-match', options.ifNoneMatch)
      r2Options.onlyIf = headers as unknown as import('@cloudflare/workers-types').Headers
    }

    try {
      const object = await this.native.get(validKey, r2Options)
      if (!object) {
        return null
      }

      // When onlyIf conditions are not met, R2 returns an R2Object without a body stream
      if (!('body' in object) || !object.body) {
        // Preserve HTTP precondition order when the binding returns metadata only.
        if (options?.ifMatch && !matchesETag(options.ifMatch, object.httpEtag, false)) {
          throw new StorageError('precondition_failed', 'If-Match condition failed')
        }
        if (options?.ifNoneMatch && matchesETag(options.ifNoneMatch, object.httpEtag, true)) {
          throw new StorageError('not_modified', 'If-None-Match condition matched')
        }

        return null
      }

      const mime =
        object.httpMetadata?.contentType ?? getMimeType(validKey) ?? 'application/octet-stream'

      const content = object.body as unknown as ReadableStream<Uint8Array>
      const bodyStream = options?.signal
        ? content.pipeThrough(new TransformStream<Uint8Array, Uint8Array>(), {
            signal: options.signal,
          })
        : content

      return {
        key: validKey,
        size: object.size,
        contentType: mime,
        etag: object.httpEtag,
        lastModified: object.uploaded,
        url: buildPublicUrl(this.publicUrl, validKey),
        body: bodyStream,
      }
    } catch (err) {
      if (err instanceof StorageError) throw err
      // The binding exposes documented R2 error codes at the end of Error.message.
      if (err instanceof Error && err.message.endsWith('(10039)')) {
        throw new StorageError('range_not_satisfiable', 'Requested R2 range is not satisfiable.', {
          cause: err,
        })
      }
      throw new StorageError('storage_error', `R2 get failed: ${String(err)}`, {
        cause: err,
      })
    }
  }

  async delete(key: string): Promise<void> {
    const validKey = validateStorageKey(key)
    try {
      await this.native.delete(validKey)
    } catch (err) {
      if (err instanceof StorageError) throw err
      throw new StorageError('storage_error', `R2 delete failed: ${String(err)}`, {
        cause: err,
      })
    }
  }
}

/** R2 FileStore with presign capability. */
class R2PresignedFileStoreImpl extends R2FileStoreBase implements R2PresignedFileStore {
  private readonly signer: (options: PresignOptions) => Promise<PresignedResult>

  constructor(
    bucket: R2Bucket,
    publicUrl: string | undefined,
    signer: (options: PresignOptions) => Promise<PresignedResult>,
  ) {
    super(bucket, publicUrl)
    this.signer = signer
  }

  async presign(options: PresignOptions): Promise<PresignedResult> {
    return this.signer(options)
  }
}

/**
 * Declares a Cloudflare R2 object storage bucket.
 *
 * @param config - R2Bucket binding and optional presign options.
 * @returns Storage declaration retaining concrete R2 configuration.
 */
export function defineStorage<
  const Presign extends PresignDeclaration<R2PresignConfig> | undefined = undefined,
>(config: R2StorageConfig<Presign>): R2StorageDeclaration<Presign>

/**
 * Declares R2 storage and presigning resolved for each Workers event.
 *
 * @param factory - Receives event bindings and returns storage and signing settings.
 * @returns A declaration retaining the signing capability and environment requirements.
 */
export function defineStorage<E, const Presign extends PresignDeclaration<R2PresignConfig>>(
  factory: (env: E) => R2StorageConfig<Presign>,
): R2StorageDeclaration<Presign> & RequiresEnv<E>

/**
 * Declares R2 storage resolved for each Workers event.
 *
 * @param factory - Receives event bindings and returns storage settings.
 * @returns A declaration retaining the factory's environment requirements.
 */
export function defineStorage<E = unknown>(
  factory: (env: E) => R2StorageConfig<undefined>,
): R2StorageDeclaration<undefined> & RequiresEnv<E>

export function defineStorage<
  const Presign extends PresignDeclaration<R2PresignConfig> | undefined = undefined,
>(
  input: R2StorageConfig<Presign> | ((env: any) => R2StorageConfig<Presign>),
): R2StorageDeclaration<Presign> {
  return {
    kind: 'storage',
    driver: 'r2',
    target: 'cloudflare',
    value: input,
    isFactory: typeof input === 'function',
    createForEvent: async (env) => {
      const config = evaluateDeclaration(input, env, 'storage')
      const bucket = config.binding
      if (!bucket) {
        throw new StorageError(
          'storage_error',
          'R2 storage requires a valid R2Bucket binding from environment.',
        )
      }

      let store: R2FileStore
      if (config.presign) {
        const validated = validateR2PresignConfig(config.presign.options)
        const signer = await config.presign.createR2Signer(validated)
        store = new R2PresignedFileStoreImpl(bucket, config.publicUrl, signer)
      } else {
        store = new R2FileStoreBase(bucket, config.publicUrl)
      }

      return {
        value: store as InferResource<R2StorageDeclaration<Presign>>,
      }
    },
  }
}
