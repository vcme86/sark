/** Presign configuration and request validation, independent of signing SDKs. */
import { getMimeType } from 'hono/utils/mime'

import { type PresignOptions, type PresignResult, StorageError, validateStorageKey } from './types'

/** Configuration for S3 presigning, reusing client credentials and target bucket. */
export interface S3PresignConfig {
  /** Maximum lifetime in seconds; defaults to 300. */
  expiresIn?: number
  endpoint?: never
  region?: never
  bucket?: never
  credentials?: never
}

/** Configuration for Cloudflare R2 presigning, requiring explicit S3 API endpoint and credentials. */
export interface R2PresignConfig {
  /** Maximum lifetime in seconds; defaults to 300. */
  expiresIn?: number
  /** R2 S3-compatible API endpoint (e.g. `https://<account_id>.r2.cloudflarestorage.com`). */
  endpoint: string | undefined
  /** Signing region; defaults to 'auto'. */
  region?: string
  /** Target bucket name. */
  bucket: string | undefined
  /** S3-compatible access key credentials for R2. */
  credentials: {
    accessKeyId: string | undefined
    secretAccessKey: string | undefined
    sessionToken?: string
  }
}

/** Supported presign configurations. */
export type PresignConfig = S3PresignConfig | R2PresignConfig

export type R2Signer = (options: PresignOptions) => Promise<PresignResult>

interface ResolvedR2PresignConfig {
  expiresIn: number
  endpoint: URL
  region: string
  bucket: string
  credentials: {
    accessKeyId: string
    secretAccessKey: string
    sessionToken?: string
  }
}

/** Presign declaration retained in storage configuration. */
export interface PresignDeclaration<Options extends PresignConfig = PresignConfig> {
  readonly kind: 'presign'
  readonly options: Options
  createR2Signer(config: ResolvedR2PresignConfig): Promise<R2Signer>
}

/** Validates S3 presign options to ensure no repeated bucket/credentials are passed. */
export function validateS3PresignConfig(config?: PresignConfig): { expiresIn: number } {
  if (!config) return { expiresIn: 300 }
  for (const field of ['endpoint', 'region', 'bucket', 'credentials'] as const) {
    if (config[field] !== undefined) {
      throw new StorageError(
        'storage_error',
        `S3 presign configuration must not specify ${field}; it reuses the parent storage configuration.`,
      )
    }
  }
  const expiresIn = config.expiresIn ?? 300
  if (!Number.isSafeInteger(expiresIn) || expiresIn <= 0 || expiresIn > 604800) {
    throw new StorageError(
      'storage_error',
      'Presign expiresIn must be an integer from 1 to 604800 seconds.',
    )
  }
  return { expiresIn }
}

/** Validates R2 presign options to ensure required S3 endpoint, bucket and credentials exist. */
export function validateR2PresignConfig(config?: PresignConfig): ResolvedR2PresignConfig {
  if (!config) {
    throw new StorageError('storage_error', 'R2 presign requires a presign configuration.')
  }
  const r2 = config as R2PresignConfig
  if (!r2.endpoint || typeof r2.endpoint !== 'string') {
    throw new StorageError(
      'storage_error',
      'R2 presign requires a valid S3-compatible endpoint URL.',
    )
  }
  let endpoint: URL
  try {
    endpoint = new URL(r2.endpoint)
  } catch (cause) {
    throw new StorageError(
      'storage_error',
      'R2 presign requires a valid S3-compatible endpoint URL.',
      { cause },
    )
  }
  if (
    !['http:', 'https:'].includes(endpoint.protocol) ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.username ||
    endpoint.password
  ) {
    throw new StorageError(
      'storage_error',
      'R2 presign endpoint must be an HTTP(S) URL without credentials, query or fragment.',
    )
  }
  if (!r2.bucket || typeof r2.bucket !== 'string') {
    throw new StorageError('storage_error', 'R2 presign requires a valid bucket name.')
  }
  if (
    !r2.credentials ||
    !r2.credentials.accessKeyId ||
    !r2.credentials.secretAccessKey ||
    typeof r2.credentials.accessKeyId !== 'string' ||
    typeof r2.credentials.secretAccessKey !== 'string'
  ) {
    throw new StorageError(
      'storage_error',
      'R2 presign requires credentials with accessKeyId and secretAccessKey.',
    )
  }
  const expiresIn = r2.expiresIn ?? 300
  if (!Number.isSafeInteger(expiresIn) || expiresIn <= 0 || expiresIn > 604800) {
    throw new StorageError(
      'storage_error',
      'Presign expiresIn must be an integer from 1 to 604800 seconds.',
    )
  }
  return {
    expiresIn,
    endpoint,
    region: r2.region ?? 'auto',
    bucket: r2.bucket,
    credentials: {
      accessKeyId: r2.credentials.accessKeyId,
      secretAccessKey: r2.credentials.secretAccessKey,
      sessionToken: r2.credentials.sessionToken,
    },
  }
}

/** Resolves per-operation signing inputs against the validated lifetime limit. */
export function resolvePresignRequest(options: PresignOptions, maximum: number) {
  const key = validateStorageKey(options.key)
  const expiresIn = options.expiresIn ?? maximum
  if (!Number.isSafeInteger(expiresIn) || expiresIn <= 0 || expiresIn > maximum) {
    throw new StorageError(
      'storage_error',
      `Requested expiresIn must be an integer from 1 to ${maximum} seconds; it must not exceed the configured maximum.`,
    )
  }
  if (options.operation !== 'get' && options.operation !== 'put') {
    throw new StorageError(
      'unsupported_operation',
      `Unsupported presign operation: ${options.operation}`,
    )
  }
  const headers: Record<string, string> =
    options.operation === 'put'
      ? { 'content-type': options.contentType ?? getMimeType(key) ?? 'application/octet-stream' }
      : {}
  return {
    key,
    expiresIn,
    headers,
    method: options.operation === 'put' ? ('PUT' as const) : ('GET' as const),
  }
}
